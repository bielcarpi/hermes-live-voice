import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileTaskStore,
  TaskStoreCorruptionError,
} from "../src/adapters/outbound/task-store/file-task-store.js";
import { runOfflineTaskCommand } from "../src/cli/task-operator.js";
import { loadConfig } from "../src/config.js";
import { createTaskRecord, transitionTask } from "../src/domain/tasks/index.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("offline task containment", () => {
  it("lists and contains one exact dispatch-unknown task without inventing an outcome", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-"));
    cleanup.push(root);
    const stateFile = join(root, "tasks-v1.json");
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: stateFile });
    const store = new FileTaskStore({ directory: root });
    const uncertain = transitionTask(
      createTaskRecord({
        ownerIdentity: "alice",
        input: "Possibly accepted mutation",
        title: "Unknown task",
        now: 1,
      }),
      "dispatching",
      { now: 2 },
    );
    const unknown = transitionTask(uncertain, "dispatch_unknown", { now: 3 });
    await store.put(unknown);
    await store.close();

    const output: string[] = [];
    await runOfflineTaskCommand(["unresolved"], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!)).toMatchObject({
      object: "hermes_live.unresolved_tasks",
      tasks: [{ taskId: unknown.taskId, status: "unknown" }],
    });
    expect(output[0]).not.toContain("Possibly accepted mutation");

    await expect(runOfflineTaskCommand(["contain", unknown.taskId], config, () => undefined)).rejects.toThrow(
      /--confirm-contained/,
    );
    await runOfflineTaskCommand(
      ["contain", unknown.taskId, "--confirm-contained"],
      config,
      (value) => output.push(value),
    );
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      object: "hermes_live.task_containment",
      contained: true,
      containedAt: expect.any(Number),
    });

    const reloaded = new FileTaskStore({ directory: root });
    const contained = await reloaded.load(unknown.taskId);
    expect(contained).toMatchObject({
      status: "dispatch_unknown",
      operatorContainedAt: expect.any(Number),
      notification: { unread: true },
    });
    expect(contained?.events.at(-1)).toMatchObject({ type: "operator_contained" });
    await reloaded.close();

    output.length = 0;
    await runOfflineTaskCommand(["unresolved"], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!).tasks).toEqual([]);
  });

  it("inspects and contains older state without applying current retention limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-preserve-"));
    cleanup.push(root);
    const stateFile = join(root, "tasks-v1.json");
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: stateFile });
    const uncertain = transitionTask(
      transitionTask(createTaskRecord({ ownerIdentity: "alice", input: "Unknown", now: 1 }), "dispatching", { now: 2 }),
      "dispatch_unknown",
      { now: 3 },
    );
    const history = Array.from({ length: 250 }, (_, index) => {
      const createdAt = 10 + index * 3;
      return transitionTask(
        transitionTask(
          createTaskRecord({ ownerIdentity: "alice", input: `History ${index}`, now: createdAt }),
          "dispatching",
          { now: createdAt + 1 },
        ),
        "cancelled",
        { now: createdAt + 2 },
      );
    });
    const original = `${JSON.stringify({
      schemaVersion: uncertain.schemaVersion,
      updatedAt: history.at(-1)!.updatedAt,
      tasks: [uncertain, ...history],
    })}\n`;
    await writeFile(stateFile, original, { mode: 0o600 });

    const output: string[] = [];
    await runOfflineTaskCommand(["unresolved"], config, (value) => output.push(value));
    expect(JSON.parse(output[0]!)).toMatchObject({
      tasks: [{ taskId: uncertain.taskId, status: "unknown" }],
    });
    expect(await readFile(stateFile, "utf8")).toBe(original);

    await runOfflineTaskCommand(
      ["contain", uncertain.taskId, "--confirm-contained"],
      config,
      () => undefined,
    );
    const containedDocument = JSON.parse(await readFile(stateFile, "utf8"));
    expect(containedDocument.tasks).toHaveLength(251);
    expect(containedDocument.tasks.map((task: { taskId: string }) => task.taskId)).toEqual(
      expect.arrayContaining(history.map((task) => task.taskId)),
    );
    expect(containedDocument.tasks.find((task: { taskId: string }) => task.taskId === uncertain.taskId))
      .toMatchObject({ operatorContainedAt: expect.any(Number) });
  });

  it("refuses offline recovery while a gateway owns the task state", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-lock-"));
    cleanup.push(root);
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: join(root, "tasks-v1.json") });
    const gatewayStore = new FileTaskStore({ directory: root });
    await gatewayStore.list();

    await expect(runOfflineTaskCommand(["unresolved"], config, () => undefined)).rejects.toThrow(
      /Stop the running Hermes Live gateway/,
    );
    await expect(
      runOfflineTaskCommand(["unlock", "--confirm-no-gateway"], config, () => undefined),
    ).rejects.toThrow(/Refusing to clear task state owned by live gateway PID/);
    await gatewayStore.close();
  });

  it("clears only an explicitly confirmed lock left by an unclean exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-unlock-"));
    cleanup.push(root);
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: join(root, "tasks-v1.json") });
    await mkdir(join(root, "tasks-v1.json.lock"), { mode: 0o700 });

    await expect(runOfflineTaskCommand(["unlock"], config, () => undefined)).rejects.toThrow(
      /--confirm-no-gateway/,
    );
    const output: string[] = [];
    await runOfflineTaskCommand(
      ["unlock", "--confirm-no-gateway"],
      config,
      (value) => output.push(value),
    );
    expect(JSON.parse(output[0]!)).toEqual({
      object: "hermes_live.task_store_unlock",
      cleared: true,
    });
  });

  it("preserves the command diagnosis when offline task-state cleanup also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-combined-failure-"));
    cleanup.push(root);
    const stateFile = join(root, "tasks-v1.json");
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: stateFile });
    await writeFile(stateFile, "{not-json", { mode: 0o600 });
    const closeFailure = new TaskStoreCorruptionError(
      "Task store writer lock was only partially released; inspect the lock directory before restarting.",
    );
    vi.spyOn(FileTaskStore.prototype, "close").mockRejectedValueOnce(closeFailure);

    const failure = await runOfflineTaskCommand(["unresolved"], config, () => undefined).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        name: "TaskStoreCorruptionError",
        message: expect.stringContaining("invalid JSON"),
      }),
      closeFailure,
    ]);
  });

  it("surfaces an offline task-store close failure after an otherwise successful command", async () => {
    const root = await mkdtemp(join(tmpdir(), "hermes-live-operator-close-failure-"));
    cleanup.push(root);
    const config = loadConfig({ HERMES_LIVE_TASK_STATE_FILE: join(root, "tasks-v1.json") });
    const closeFailure = new Error("offline task-store close failed");
    vi.spyOn(FileTaskStore.prototype, "close").mockRejectedValueOnce(closeFailure);

    await expect(runOfflineTaskCommand(["unresolved"], config, () => undefined)).rejects.toBe(closeFailure);
  });
});
