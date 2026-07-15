import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileTaskStore,
  TaskStoreCapacityError,
  TaskStoreConflictError,
  TaskStoreCorruptionError,
} from "../src/adapters/outbound/task-store/file-task-store.js";
import {
  acknowledgeTaskNotification,
  appendTaskEvent,
  createTaskRecord,
  markTaskStopRequested,
  transitionTask,
} from "../src/domain/tasks/index.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("FileTaskStore", () => {
  it("atomically persists validated tasks with private permissions and reloads them", async () => {
    const { root, directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory, now: () => 100 });
    const task = createTaskRecord({ ownerIdentity: "alice", input: "Review authentication", now: 10 });

    await expect(store.put(task)).resolves.toEqual(task);
    const directoryMode = (await stat(directory)).mode & 0o777;
    const fileMode = (await stat(store.filePath)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const reloaded = new FileTaskStore({ directory });
    await expect(reloaded.load(task.taskId)).resolves.toEqual(task);
    await expect(reloaded.list({ ownerId: task.ownerId })).resolves.toEqual([task]);
    const raw = JSON.parse(await readFile(join(directory, "tasks-v1.json"), "utf8"));
    expect(raw).toMatchObject({ schemaVersion: 1, tasks: [{ taskId: task.taskId }] });
    expect(root).toBeTruthy();
  });

  it("filters every retained unread notification without applying the recent-history limit", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory, now: () => 100 });
    const oldUnread = transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Old unread", now: 1 }),
      "cancelled",
      { now: 2 },
    );
    const recentRead = acknowledgeTaskNotification(transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Recent read", now: 10 }),
      "cancelled",
      { now: 11 },
    ), 12);
    await store.put(oldUnread);
    await store.put(recentRead);

    await expect(store.list({ ownerId: oldUnread.ownerId, limit: 1 })).resolves.toEqual([recentRead]);
    await expect(store.list({
      ownerId: oldUnread.ownerId,
      notificationUnread: true,
    })).resolves.toEqual([oldUnread]);
  });

  it("returns the full configured capacity above the former fixed 1,000-record query ceiling", async () => {
    const { directory } = await temporaryStoreDirectory();
    const records = Array.from({ length: 1_001 }, (_, index) => createTaskRecord({
      ownerIdentity: "alice",
      input: `Retained task ${index + 1}`,
      now: index + 1,
      taskId: `task_${(index + 1).toString(16).padStart(32, "0")}`,
    }));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "tasks-v1.json"), JSON.stringify({
      schemaVersion: 1,
      updatedAt: records.length,
      tasks: records,
    }), { mode: 0o600 });
    const store = new FileTaskStore({ directory, maxRecords: records.length });

    await expect(store.list()).resolves.toHaveLength(records.length);
    await expect(store.list({ limit: records.length })).resolves.toHaveLength(records.length);
    await expect(store.list({ limit: records.length + 1 })).resolves.toHaveLength(records.length);
  });

  it("serializes concurrent compare-and-swap updates without losing revisions", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory });
    const queued = createTaskRecord({ ownerIdentity: "alice", input: "Run tests", now: 10 });
    await store.put(queued);

    const first = store.update(
      queued.taskId,
      (current) => transitionTask(current, "dispatching", { now: 11 }),
      { expectedRevision: 1 },
    );
    const stale = store.update(
      queued.taskId,
      (current) => transitionTask(current, "cancelled", { now: 12 }),
      { expectedRevision: 1 },
    );

    await expect(first).resolves.toMatchObject({ revision: 2, status: "dispatching" });
    await expect(stale).rejects.toThrow(TaskStoreConflictError);
    await expect(store.load(queued.taskId)).resolves.toMatchObject({ revision: 2, status: "dispatching" });
  });

  it("returns defensive copies and enforces create/update identity contracts", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory });
    const task = createTaskRecord({ ownerIdentity: "alice", input: "Audit docs", now: 10 });
    await store.put(task);

    const loaded = await store.load(task.taskId);
    loaded!.title = "mutated outside store";
    expect((await store.load(task.taskId))?.title).toBe(task.title);
    await expect(store.put(task)).rejects.toThrow(TaskStoreConflictError);
    await expect(store.update(task.taskId, (current) => ({ ...current, revision: current.revision + 2 }))).rejects.toThrow(
      /revision/,
    );

    await expect(store.update(task.taskId, (current) => ({
      ...transitionTask(current, "dispatching", { now: 11 }),
      title: "Rewritten task definition",
    }))).rejects.toThrow(/execution-definition fields are immutable/);

    await expect(store.update(task.taskId, (current) => {
      const updated = transitionTask(current, "dispatching", { now: 11 });
      updated.events[0] = { ...updated.events[0]!, summary: "Rewritten history." };
      return updated;
    })).rejects.toThrow(/event history is append-only/);
  });

  it("accepts idempotent duplicate lifecycle updates without rewriting revisions", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory });
    const queued = createTaskRecord({ ownerIdentity: "alice", input: "Check status", now: 10 });
    const cancelled = transitionTask(queued, "cancelled", { now: 11 });
    await store.put(cancelled);

    const duplicate = await store.update(
      cancelled.taskId,
      (current) => transitionTask(current, "cancelled", { now: 12 }),
      { expectedRevision: cancelled.revision },
    );

    expect(duplicate).toEqual(cancelled);
    expect(duplicate.revision).toBe(cancelled.revision);
  });

  it("makes persisted exact-stop intent append-only and requires its audit event", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory });
    const queued = createTaskRecord({ ownerIdentity: "alice", input: "Stop exactly once", now: 10 });
    await store.put(queued);

    await expect(store.update(queued.taskId, (current) => ({
      ...appendTaskEvent(current, { summary: "Unrelated update", now: 11 }),
      stopRequestedAt: 11,
    }))).rejects.toThrow(/requires its append-only stop event/);

    const requested = await store.update(queued.taskId, (current) =>
      markTaskStopRequested(current, { now: 12 }));
    expect(requested.stopRequestedAt).toBe(12);

    await expect(store.update(queued.taskId, (current) => ({
      ...appendTaskEvent(current, { summary: "Attempted rewrite", now: 13 }),
      stopRequestedAt: 13,
    }))).rejects.toThrow(/stop intent is append-only/);

    await expect(store.update(queued.taskId, (current) => {
      const updated = appendTaskEvent(current, { summary: "Attempted removal", now: 14 });
      delete updated.stopRequestedAt;
      return updated;
    })).rejects.toThrow(/stop intent is append-only/);

    await expect(store.load(queued.taskId)).resolves.toEqual(requested);
  });

  it("prunes only terminal records by retention and capacity", async () => {
    const { directory } = await temporaryStoreDirectory();
    let now = 100;
    const store = new FileTaskStore({ directory, maxRecords: 3, retentionMs: 100, now: () => now });
    const active = createTaskRecord({ ownerIdentity: "alice", input: "Active", now: 10 });
    const oldTerminal = transitionTask(
      transitionTask(createTaskRecord({ ownerIdentity: "alice", input: "Old", now: 20 }), "dispatching", { now: 21 }),
      "cancelled",
      { now: 22 },
    );
    const recentTerminal = transitionTask(
      transitionTask(createTaskRecord({ ownerIdentity: "alice", input: "Recent", now: 950 }), "dispatching", { now: 951 }),
      "failed",
      { error: "failed", now: 952 },
    );
    await store.put(active);
    await store.put(oldTerminal);
    await store.put(recentTerminal);

    now = 1_000;
    const pruned = await store.prune();
    expect(pruned.taskIds).toEqual([oldTerminal.taskId]);
    expect(await store.load(active.taskId)).toBeDefined();
    expect(await store.load(recentTerminal.taskId)).toBeDefined();

    now = 2_000;
    await expect(store.prune({ maxRecords: 1 })).resolves.toMatchObject({ deleted: 1 });
    expect(await store.load(active.taskId)).toBeDefined();
  });

  it("safely prunes terminal history when a later configuration lowers capacity", async () => {
    const { directory } = await temporaryStoreDirectory();
    const initial = new FileTaskStore({ directory, maxRecords: 3, retentionMs: 10_000, now: () => 100 });
    const active = createTaskRecord({ ownerIdentity: "alice", input: "Active", now: 1 });
    const oldTerminal = transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Old", now: 2 }),
      "cancelled",
      { now: 3 },
    );
    const recentTerminal = transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Recent", now: 4 }),
      "cancelled",
      { now: 5 },
    );
    await initial.put(active);
    await initial.put(oldTerminal);
    await initial.put(recentTerminal);

    const reduced = new FileTaskStore({ directory, maxRecords: 2, retentionMs: 10_000, now: () => 100 });
    await expect(reduced.list()).resolves.toHaveLength(2);
    await expect(reduced.load(active.taskId)).resolves.toBeDefined();
    await expect(reduced.load(oldTerminal.taskId)).resolves.toBeUndefined();
    await expect(reduced.load(recentTerminal.taskId)).resolves.toBeDefined();
  });

  it("fails closed on every load when lowered capacity cannot prune active records", async () => {
    const { directory } = await temporaryStoreDirectory();
    const initial = new FileTaskStore({ directory, maxRecords: 2, retentionMs: 10_000, now: () => 100 });
    await initial.put(createTaskRecord({ ownerIdentity: "alice", input: "Active one", now: 1 }));
    await initial.put(createTaskRecord({ ownerIdentity: "alice", input: "Active two", now: 2 }));

    const reduced = new FileTaskStore({ directory, maxRecords: 1, retentionMs: 10_000, now: () => 100 });
    await expect(reduced.list()).rejects.toThrow(TaskStoreCorruptionError);
    await expect(reduced.list()).rejects.toThrow(TaskStoreCorruptionError);
  });

  it("refuses capacity overflow when every retained task is non-terminal", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory, maxRecords: 1 });
    await store.put(createTaskRecord({ ownerIdentity: "alice", input: "First", now: 1 }));
    await expect(store.put(createTaskRecord({ ownerIdentity: "alice", input: "Second", now: 2 }))).rejects.toThrow(
      TaskStoreCapacityError,
    );
  });

  it("fails safely on corrupt state without overwriting or resetting it", async () => {
    const { directory } = await temporaryStoreDirectory();
    const path = join(directory, "tasks-v1.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, "{not-json", { mode: 0o600 });
    const store = new FileTaskStore({ directory });

    await expect(store.list()).rejects.toThrow(TaskStoreCorruptionError);
    await expect(store.put(createTaskRecord({ ownerIdentity: "alice", input: "Do not overwrite" }))).rejects.toThrow(
      TaskStoreCorruptionError,
    );
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });

  it.skipIf(process.platform === "win32")("refuses symbolic-link state files without following them", async () => {
    const { root, directory } = await temporaryStoreDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(root, "attacker-controlled.json");
    await writeFile(target, JSON.stringify({ schemaVersion: 1, updatedAt: 0, tasks: [] }), { mode: 0o600 });
    await symlink(target, join(directory, "tasks-v1.json"));

    const store = new FileTaskStore({ directory });
    await expect(store.list()).rejects.toThrow(TaskStoreCorruptionError);
    expect(await readFile(target, "utf8")).toContain("\"tasks\":[]");
  });

  it("deletes exact records and leaves missing deletes idempotent", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory });
    const task = createTaskRecord({ ownerIdentity: "alice", input: "Temporary", now: 1 });
    await store.put(task);
    await expect(store.delete(task.taskId)).resolves.toBe(true);
    await expect(store.delete(task.taskId)).resolves.toBe(false);
    await expect(store.load(task.taskId)).resolves.toBeUndefined();
  });
});

async function temporaryStoreDirectory(): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), "hermes-live-task-store-"));
  cleanupPaths.push(root);
  return { root, directory: join(root, "state") };
}
