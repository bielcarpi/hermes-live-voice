import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileTaskStore,
  TaskStoreCapacityError,
  TaskStoreConflictError,
  TaskStoreCorruptionError,
  TaskStoreLockedError,
  clearAbandonedTaskStoreLock,
} from "../src/adapters/outbound/task-store/file-task-store.js";
import {
  acknowledgeTaskNotification,
  appendTaskEvent,
  createTaskRecord,
  MAX_TASK_OUTPUT_CHARS,
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

    await store.close();
    const reloaded = new FileTaskStore({ directory });
    await expect(reloaded.load(task.taskId)).resolves.toEqual(task);
    await expect(reloaded.list({ ownerId: task.ownerId })).resolves.toEqual([task]);
    const raw = JSON.parse(await readFile(join(directory, "tasks-v1.json"), "utf8"));
    expect(raw).toMatchObject({ schemaVersion: 1, tasks: [{ taskId: task.taskId }] });
    await reloaded.close();
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

  it("holds one exclusive writer lease for the lifetime of a store", async () => {
    const { directory } = await temporaryStoreDirectory();
    const first = new FileTaskStore({ directory });
    const second = new FileTaskStore({ directory });
    const task = createTaskRecord({ ownerIdentity: "alice", input: "Single writer", now: 1 });

    await first.put(task);
    await expect(second.list()).rejects.toThrow(TaskStoreLockedError);
    await first.close();
    await expect(second.load(task.taskId)).resolves.toEqual(task);
    await second.close();
  });

  it("never steals an abandoned writer lock and requires an explicit safe unlock", async () => {
    const { directory } = await temporaryStoreDirectory();
    const lockDirectory = join(directory, "tasks-v1.json.lock");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({
      schemaVersion: 1,
      token: randomUUID(),
      pid: 999_999,
      hostname: `${hostname()}-abandoned`,
      acquiredAt: 1,
    }), { mode: 0o600 });

    const first = new FileTaskStore({ directory });
    const second = new FileTaskStore({ directory });
    await expect(first.list()).rejects.toThrow(TaskStoreLockedError);
    await expect(second.list()).rejects.toThrow(TaskStoreLockedError);

    await expect(clearAbandonedTaskStoreLock({ directory })).resolves.toMatchObject({
      cleared: true,
      ownerPid: 999_999,
    });
    const results = await Promise.allSettled([first.list(), second.list()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(TaskStoreLockedError) });
    await first.close();
    await second.close();
    await expect(stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to clear a lock held by a live same-host gateway", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory });
    await store.list();

    await expect(clearAbandonedTaskStoreLock({ directory })).rejects.toThrow(
      /Refusing to clear task state owned by live gateway PID/,
    );
    await store.close();
    await expect(clearAbandonedTaskStoreLock({ directory })).resolves.toEqual({ cleared: false });
  });

  it("can explicitly clear partial lock metadata left by a crash during acquisition", async () => {
    const { directory } = await temporaryStoreDirectory();
    const lockDirectory = join(directory, "tasks-v1.json.lock");
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(lockDirectory, "owner.json"), "{partial", { mode: 0o600 });

    await expect(clearAbandonedTaskStoreLock({ directory })).resolves.toEqual({
      cleared: true,
      ownerMetadataValid: false,
    });
    const store = new FileTaskStore({ directory });
    await expect(store.list()).resolves.toEqual([]);
    await store.close();
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

  it("requires an exact append-only event before treating an upstream run as missing", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory });
    const unknown = transitionTask(
      transitionTask(
        transitionTask(createTaskRecord({ ownerIdentity: "alice", input: "Recover run", now: 1 }), "dispatching", { now: 2 }),
        "running",
        { now: 3, runId: "run_missing" },
      ),
      "unknown",
      { now: 4 },
    );
    await store.put(unknown);

    await expect(store.update(unknown.taskId, (current) => ({
      ...appendTaskEvent(current, { summary: "Unrelated reconciliation note.", now: 5 }),
      upstreamRunMissingAt: 4,
    }))).rejects.toThrow(/exact append-only unknown event/);

    const confirmed = await store.update(unknown.taskId, (current) =>
      transitionTask(current, "unknown", { now: 6, upstreamRunMissing: true }));
    expect(confirmed.upstreamRunMissingAt).toBe(6);
    expect(confirmed.events.at(-1)).toMatchObject({ type: "unknown", timestamp: 6 });

    await expect(store.update(unknown.taskId, (current) => {
      const changed = appendTaskEvent(current, { summary: "Attempted removal.", now: 7 });
      delete changed.upstreamRunMissingAt;
      return changed;
    })).rejects.toThrow(/missing upstream run is append-only/);
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

  it("evicts acknowledged history before an older unread inbox item at capacity", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({ directory, maxRecords: 2, retentionMs: 10_000, now: () => 100 });
    const unread = transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Unread", now: 10 }),
      "cancelled",
      { now: 11 },
    );
    const acknowledged = acknowledgeTaskNotification(transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Acknowledged", now: 20 }),
      "cancelled",
      { now: 21 },
    ), 22);
    await store.put(unread);
    await store.put(acknowledged);
    const active = createTaskRecord({ ownerIdentity: "alice", input: "Current", now: 30 });
    await store.put(active);

    await expect(store.load(unread.taskId)).resolves.toBeDefined();
    await expect(store.load(acknowledged.taskId)).resolves.toBeUndefined();
    await expect(store.load(active.taskId)).resolves.toBeDefined();
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
    await initial.close();

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
    await initial.close();

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

  it("backfills terminal reserve when loading valid pre-reserve state", async () => {
    const { directory } = await temporaryStoreDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const maxStoreBytes = (2 * 1024 * 1024) + (64 * 1024) + 10_000;
    const old = transitionTask(
      transitionTask(
        transitionTask(createTaskRecord({ ownerIdentity: "alice", input: "Old", now: 1 }), "dispatching", { now: 2 }),
        "running",
        { now: 3, runId: "run_old" },
      ),
      "completed",
      { now: 4, output: "o".repeat(20_000), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    );
    const queued = createTaskRecord({ ownerIdentity: "alice", input: "Current", now: 5 });
    const running = transitionTask(transitionTask(queued, "dispatching", { now: 6 }), "running", {
      now: 7,
      runId: "run_current",
    });
    await writeFile(join(directory, "tasks-v1.json"), `${JSON.stringify({
      schemaVersion: running.schemaVersion,
      updatedAt: running.updatedAt,
      tasks: [old, running],
    })}\n`, { mode: 0o600 });
    const store = new FileTaskStore({
      directory,
      maxRecords: 10,
      maxStoreBytes,
      retentionMs: 10_000,
      now: () => 8,
    });

    await store.list();
    await expect(store.load(old.taskId)).resolves.toBeUndefined();

    const completed = await store.update(running.taskId, (current) => transitionTask(current, "completed", {
      now: 8,
      // Lone surrogates exercise JSON's six-byte escape expansion per UTF-16
      // code unit, which is larger than ordinary UTF-8 output.
      output: "\ud800".repeat(MAX_TASK_OUTPUT_CHARS),
      outputTruncated: true,
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
    }));
    expect(completed.status).toBe("completed");
    await expect(store.load(running.taskId)).resolves.toMatchObject({
      status: "completed",
      output: "\ud800".repeat(MAX_TASK_OUTPUT_CHARS),
      outputTruncated: true,
    });
    expect((await stat(store.filePath)).size).toBeLessThanOrEqual(maxStoreBytes);
  });

  it("drains near-limit beta state through bounded migration headroom without admitting new work", async () => {
    const { directory } = await temporaryStoreDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const maxStoreBytes = Math.floor(2.2 * 1024 * 1024);
    const queued = createTaskRecord({
      ownerIdentity: "alice",
      input: "\ud800".repeat(100_000),
      now: 1,
    });
    const running = transitionTask(transitionTask(createTaskRecord({
      ownerIdentity: "alice",
      input: "\ud800".repeat(100_000),
      now: 2,
    }), "dispatching", { now: 3 }), "running", { now: 4, runId: "run_beta" });
    const path = join(directory, "tasks-v1.json");
    await writeFile(path, `${JSON.stringify({
      schemaVersion: running.schemaVersion,
      updatedAt: running.updatedAt,
      tasks: [queued, running],
    })}\n`, { mode: 0o600 });
    expect((await stat(path)).size).toBeLessThan(maxStoreBytes);

    const store = new FileTaskStore({
      directory,
      maxRecords: 4,
      maxStoreBytes,
      terminalReserveSlots: 1,
      retentionMs: 10_000,
      now: () => 5,
    });
    await expect(store.list()).resolves.toHaveLength(2);
    await expect(store.put(createTaskRecord({
      ownerIdentity: "alice",
      input: "A new task must fit the normal budget",
      now: 5,
    }))).rejects.toThrow(TaskStoreCapacityError);

    await store.update(running.taskId, (current) => transitionTask(current, "completed", {
      now: 5,
      output: "\ud800".repeat(MAX_TASK_OUTPUT_CHARS),
      outputTruncated: true,
    }));
    expect((await stat(path)).size).toBeGreaterThan(maxStoreBytes);
    await store.close();

    const reloaded = new FileTaskStore({
      directory,
      maxRecords: 4,
      maxStoreBytes,
      terminalReserveSlots: 1,
      retentionMs: 10_000,
      now: () => 6,
    });
    await expect(reloaded.load(queued.taskId)).resolves.toMatchObject({ status: "queued" });
    await expect(reloaded.load(running.taskId)).resolves.toMatchObject({
      status: "completed",
      output: "\ud800".repeat(MAX_TASK_OUTPUT_CHARS),
    });
    await reloaded.close();
  });

  it("reserves a largest terminal transition for every task the configured concurrency can admit", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({
      directory,
      maxRecords: 6,
      maxStoreBytes: 8 * 1024 * 1024,
      terminalReserveSlots: 3,
      now: () => 20,
    });
    const queued = await Promise.all(Array.from({ length: 3 }, (_, index) => store.put(createTaskRecord({
      ownerIdentity: "alice",
      input: `Task ${index} ${"i".repeat(100_000 - 7)}`,
      now: index + 1,
    }))));
    const running: typeof queued = [];
    for (const [index, task] of queued.entries()) {
      const dispatching = await store.update(task.taskId, (current) => transitionTask(current, "dispatching", {
        now: 10 + index,
      }));
      running.push(await store.update(task.taskId, (current) => transitionTask(current, "running", {
        now: dispatching.updatedAt + 1,
        runId: `run_concurrent_${index}`,
      })));
    }
    for (const [index, task] of running.entries()) {
      await expect(store.update(task.taskId, (current) => transitionTask(current, "completed", {
        now: 20 + index,
        output: "\ud800".repeat(MAX_TASK_OUTPUT_CHARS),
        outputTruncated: true,
      }))).resolves.toMatchObject({ status: "completed" });
    }
    await expect(store.list({ statuses: ["completed"] })).resolves.toHaveLength(3);
    expect((await stat(store.filePath)).size).toBeLessThanOrEqual(8 * 1024 * 1024);
    await store.close();
  });

  it("lets a terminal result consume its slot before queued backlog reclaims capacity", async () => {
    const { directory } = await temporaryStoreDirectory();
    const store = new FileTaskStore({
      directory,
      maxRecords: 8,
      maxStoreBytes: 8 * 1024 * 1024,
      terminalReserveSlots: 3,
      now: () => 50,
    });
    const inputLengths = [80_000, 80_000, 80_000, 97_780];
    const tasks = await Promise.all(inputLengths.map((inputLength, index) => store.put(createTaskRecord({
      ownerIdentity: "alice",
      input: "\ud800".repeat(inputLength),
      now: index + 1,
    }))));
    // Leave only a few bytes beneath the admission payload ceiling. The first
    // state transition must be able to consume the separate control reserve.
    expect((await stat(store.filePath)).size).toBeGreaterThan(2_031_500);
    for (const [index, task] of tasks.slice(0, 3).entries()) {
      await store.update(task.taskId, (current) => transitionTask(current, "dispatching", { now: 10 + index }));
      await store.update(task.taskId, (current) => transitionTask(current, "running", {
        now: 20 + index,
        runId: `run_backlog_${index}`,
      }));
    }

    await expect(store.update(tasks[0]!.taskId, (current) => transitionTask(current, "completed", {
      now: 30,
      output: "\ud800".repeat(MAX_TASK_OUTPUT_CHARS),
      outputTruncated: true,
    }))).resolves.toMatchObject({ status: "completed" });

    // Reclaiming the freed concurrency slot is a separate pre-dispatch write.
    // It may evict the now-closed result, but it must succeed before Hermes can
    // receive the next run request.
    await expect(store.update(tasks[3]!.taskId, (current) => transitionTask(current, "dispatching", {
      now: 31,
    }))).resolves.toMatchObject({ status: "dispatching" });
    await expect(store.load(tasks[0]!.taskId)).resolves.toBeUndefined();
    await store.close();
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

  it("reports a dirty writer lock when initial-load cleanup can only partially release it", async () => {
    const { directory } = await temporaryStoreDirectory();
    const path = join(directory, "tasks-v1.json");
    const lockDirectory = `${path}.lock`;
    const unexpectedLockEntry = join(lockDirectory, "unexpected-entry");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, "{not-json", { mode: 0o600 });
    let injected = false;
    const store = new FileTaskStore({
      directory,
      now: () => {
        if (!injected) {
          injected = true;
          // acquireLock() creates the directory before obtaining its timestamp.
          // This deterministic sidecar makes rmdir fail after owner.json is
          // removed, exercising a genuinely partial lock release.
          writeFileSync(unexpectedLockEntry, "inspect before removing", { mode: 0o600 });
        }
        return 100;
      },
    });

    const failure = await store.list().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.any(TaskStoreCorruptionError),
      expect.objectContaining({
        name: "TaskStoreCorruptionError",
        message: expect.stringContaining("only partially released"),
      }),
    ]);
    await expect(readFile(unexpectedLockEntry, "utf8")).resolves.toBe("inspect before removing");
    await expect(store.close()).rejects.toThrow(/only partially released/);
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
