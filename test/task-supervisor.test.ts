import { describe, expect, it } from "vitest";
import type {
  ApprovalResult,
  HermesCapabilities,
  HermesRequestOptions,
  HermesRunSnapshot,
  HermesRunsPort,
  StartRunParams,
  StartRunResult,
} from "../src/application/live-gateway/ports/hermes-runs.port.js";
import type {
  TaskListOptions,
  TaskPruneOptions,
  TaskPruneResult,
  TaskStorePort,
  TaskUpdateOptions,
} from "../src/application/task-supervisor/ports/task-store.port.js";
import {
  TaskNotFoundError,
  TaskQueueFullError,
  TaskSupervisor,
  type TaskSupervisorScheduler,
} from "../src/application/task-supervisor/task-supervisor.js";
import type { ApprovalChoice } from "../src/domain/protocol/client-protocol.js";
import type { HermesRunEvent } from "../src/domain/protocol/server-protocol.js";
import {
  acknowledgeTaskNotification,
  containIndeterminateTask,
  createTaskRecord,
  hashTaskOwnerId,
  isTaskTerminal,
  markTaskStopRequested,
  parseTaskRecord,
  transitionTask,
  type TaskRecord,
} from "../src/domain/tasks/index.js";

describe("TaskSupervisor", () => {
  it("creates durable follow-up work from a finished task with explicit lineage", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({ store, hermes, maxConcurrent: 2 });
    await supervisor.initialize();
    const ownerId = supervisor.registerOwner("alice", "session-a");
    const root = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Audit the release",
    });
    await waitFor(() => hermes.startCalls.length === 1);
    const rootRunId = (await store.load(root.taskId))?.runId!;
    hermes.pushEvent(rootRunId, {
      event: "run.completed",
      run_id: rootRunId,
      output: "The audit found one missing changelog entry.",
      usage: { input_tokens: 8, output_tokens: 7, total_tokens: 15 },
    });
    await waitFor(async () => (await store.load(root.taskId))?.status === "completed");

    const followUp = await supervisor.followUp({
      ownerIdentity: "alice",
      ownerId,
      sessionKey: "session-a",
      parentTaskId: root.taskId,
      input: "Add the missing entry and verify it.",
      originConversationId: "saved_chat",
    });
    expect(followUp).toMatchObject({
      kind: "follow_up",
      parentTaskId: root.taskId,
      rootTaskId: root.taskId,
      originConversationId: "saved_chat",
      status: "queued",
    });
    await waitFor(() => hermes.startCalls.length === 2);
    expect(hermes.startCalls[1]?.input).toContain("The audit found one missing changelog entry.");
    expect(hermes.startCalls[1]?.input).toContain("Add the missing entry and verify it.");
    await supervisor.close();
  });

  it("persists useful sanitized tool activity without leaking credentials", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();
    const task = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Inspect the repository",
    });
    await waitFor(async () => Boolean((await store.load(task.taskId))?.runId));
    const runId = (await store.load(task.taskId))?.runId!;
    hermes.pushEvent(runId, {
      event: "tool.started",
      run_id: runId,
      tool: "terminal",
      preview: "git status token=secret-value sk-examplecredential123",
    });
    await waitFor(async () => (await store.load(task.taskId))?.events.at(-1)?.type === "progress");
    const summary = (await store.load(task.taskId))?.events.at(-1)?.summary;
    expect(summary).toContain("Hermes is using terminal: git status");
    expect(summary).toContain("[redacted]");
    expect(summary).not.toContain("secret-value");
    expect(summary).not.toContain("examplecredential123");
    await supervisor.close();
  });

  it("persists an immediate queued receipt before dispatch and never persists the session key", async () => {
    const deferred = deferredValue<StartRunResult>();
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    hermes.startBehavior = () => deferred.promise;
    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();

    const ownerId = supervisor.registerOwner("alice", "owner-secret-session-key");
    const observed: TaskRecord[] = [];
    supervisor.subscribe(ownerId, (record) => {
      observed.push(record);
      record.title = "subscriber mutation";
    });

    const receipt = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "owner-secret-session-key",
      input: "Review the release",
      resourceKeys: ["repo:release"],
    });

    expect(receipt.status).toBe("queued");
    await waitFor(() => hermes.startCalls.length === 1);
    expect(store.writes.slice(0, 2).map((record) => record.status)).toEqual(["queued", "dispatching"]);
    expect(JSON.stringify(store.writes)).not.toContain("owner-secret-session-key");
    expect(hermes.startCalls[0]).toMatchObject({
      input: "Review the release",
      sessionId: `hermes-live:task:${receipt.taskId}`,
      sessionKey: "owner-secret-session-key",
    });
    expect((await store.load(receipt.taskId))?.title).toBe("Review the release");

    deferred.resolve({ runId: "run_receipt", status: "queued" });
    await waitFor(async () => (await store.load(receipt.taskId))?.runId === "run_receipt");
    expect((await store.load(receipt.taskId))?.status).toBe("running");
    expect(observed.map((record) => record.status)).toEqual(expect.arrayContaining(["queued", "dispatching", "running"]));
    await supervisor.close();
  });

  it("never loses a confirmed Hermes run ID when the first post-accept state write fails", async () => {
    const store = new FailOnceAcceptedRunStore();
    const hermes = new HermesHarness();
    hermes.startBehavior = async () => ({ runId: "run_known_after_write_failure", status: "queued" });
    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();

    const task = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Run exactly once",
    });
    await waitFor(async () => (await store.load(task.taskId))?.runId === "run_known_after_write_failure");

    expect(hermes.startCalls).toHaveLength(1);
    expect(await store.load(task.taskId)).toMatchObject({
      status: "running",
      runId: "run_known_after_write_failure",
    });
    expect(store.writes.some((record) => record.status === "dispatch_unknown")).toBe(false);
    await waitFor(() => hermes.streamCalls.includes("run_known_after_write_failure"));
    await supervisor.health();
    await supervisor.close();
  });

  it("keeps readiness degraded while an accepted run ID is only in volatile retry state", async () => {
    const scheduler = new ManualScheduler();
    const store = new GateAcceptedRunStore();
    const hermes = new HermesHarness();
    hermes.startBehavior = async () => ({ runId: "run_gated_persistence", status: "queued" });
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      scheduler,
      now: () => scheduler.now,
      retryBaseMs: 100,
      retryMaxMs: 100,
    });
    await supervisor.initialize();
    const ownerId = supervisor.registerOwner("alice", "session-a");
    const task = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Persist the exact run before readiness",
    });
    await waitFor(() => store.rejectedAcceptedRunWrites > 0);

    const stoppedDuringRetry = await supervisor.stop(ownerId, task.taskId);
    expect(stoppedDuringRetry).toMatchObject({
      status: "dispatching",
      stopRequestedAt: expect.any(Number),
    });
    await expect(supervisor.health()).rejects.toThrow("exact run ID is not yet durable");

    store.allowAcceptedRunWrites = true;
    scheduler.advanceBy(100);
    await waitFor(() => hermes.stopCalls.includes("run_gated_persistence"));
    await expect(supervisor.health()).resolves.toBeUndefined();
    await supervisor.close();
  });

  it("uses shutdown's final retry to preserve an accepted run ID before closing task state", async () => {
    const scheduler = new ManualScheduler();
    const store = new GateAcceptedRunStore();
    const hermes = new HermesHarness();
    hermes.startBehavior = async () => ({ runId: "run_preserved_during_close", status: "queued" });
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      scheduler,
      now: () => scheduler.now,
      retryBaseMs: 100,
      retryMaxMs: 100,
    });
    await supervisor.initialize();
    const task = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Preserve the accepted run while shutting down",
    });
    await waitFor(() => store.rejectedAcceptedRunWrites > 0);

    store.allowAcceptedRunWrites = true;
    const firstClose = supervisor.close();
    expect(supervisor.close()).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();

    expect(store.closeCalls).toBe(1);
    expect(await store.load(task.taskId)).toMatchObject({
      status: "running",
      runId: "run_preserved_during_close",
    });
  });

  it("rejects shutdown when the final accepted-run persistence attempt still fails", async () => {
    const scheduler = new ManualScheduler();
    const store = new GateAcceptedRunStore();
    const hermes = new HermesHarness();
    hermes.startBehavior = async () => ({ runId: "run_not_durable_at_close", status: "queued" });
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      scheduler,
      now: () => scheduler.now,
      retryBaseMs: 100,
      retryMaxMs: 100,
    });
    await supervisor.initialize();
    const task = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Do not report a clean shutdown",
    });
    await waitFor(() => store.rejectedAcceptedRunWrites > 0);

    const firstClose = supervisor.close();
    expect(supervisor.close()).toBe(firstClose);
    await expect(firstClose).rejects.toThrow("accepted run persistence remains unavailable");

    expect(store.closeCalls).toBe(1);
    const durable = await store.load(task.taskId);
    expect(durable?.status).toBe("dispatching");
    expect(durable?.runId).toBeUndefined();
  });

  it("aggregates final accepted-run persistence and task-store close failures", async () => {
    const scheduler = new ManualScheduler();
    const store = new GateAcceptedRunStore();
    const closeFailure = new Error("task-store lock release failed during shutdown");
    store.closeFailure = closeFailure;
    const hermes = new HermesHarness();
    hermes.startBehavior = async () => ({ runId: "run_and_store_close_failed", status: "queued" });
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      scheduler,
      now: () => scheduler.now,
      retryBaseMs: 100,
      retryMaxMs: 100,
    });
    await supervisor.initialize();
    await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Surface every shutdown failure",
    });
    await waitFor(() => store.rejectedAcceptedRunWrites > 0);

    const failure = await supervisor.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "accepted run persistence remains unavailable" }),
      closeFailure,
    ]);
    expect(store.closeCalls).toBe(1);
  });

  it("parallelizes only disjoint read-only tasks and keeps exclusive work alone", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({ store, hermes, maxConcurrent: 3, trustDeclaredReadOnly: true });
    await supervisor.initialize();

    const first = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Read repo A",
      executionMode: "parallel_read_only",
      resourceKeys: ["repo:a"],
    });
    const second = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Read repo B",
      executionMode: "parallel_read_only",
      resourceKeys: ["repo:b"],
    });
    const sameResource = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Read repo A again",
      executionMode: "parallel_read_only",
      resourceKeys: ["repo:a"],
    });
    const exclusive = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Publish release",
      executionMode: "exclusive",
      resourceKeys: ["repo:release"],
    });

    await waitFor(() => hermes.startCalls.length === 2);
    expect(hermes.startCalls.map((call) => call.input)).toEqual(["Read repo A", "Read repo B"]);
    expect((await store.load(sameResource.taskId))?.status).toBe("queued");
    expect((await store.load(exclusive.taskId))?.status).toBe("queued");

    const firstRun = (await store.load(first.taskId))!.runId!;
    hermes.pushEvent(firstRun, { event: "run.completed", run_id: firstRun, output: "first done" });
    await waitFor(async () => (await store.load(first.taskId))?.status === "completed");
    await waitFor(() => hermes.startCalls.length === 3);
    expect(hermes.startCalls[2]?.input).toBe("Read repo A again");

    const secondRun = (await store.load(second.taskId))!.runId!;
    const sameRun = (await store.load(sameResource.taskId))!.runId!;
    hermes.pushEvent(secondRun, { event: "run.completed", run_id: secondRun, output: "second done" });
    hermes.pushEvent(sameRun, { event: "run.completed", run_id: sameRun, output: "same done" });
    await waitFor(async () => (await store.load(sameResource.taskId))?.status === "completed");
    await waitFor(() => hermes.startCalls.length === 4);
    expect(hermes.startCalls[3]?.input).toBe("Publish release");
    await supervisor.close();
  });

  it("treats persisted read-only records as exclusive when the trust opt-in is disabled", async () => {
    const store = new MemoryTaskStore();
    const first = createTaskRecord({
      ownerIdentity: "alice",
      input: "Persisted read A",
      executionMode: "parallel_read_only",
      resourceKeys: ["repo:a"],
      now: 1,
    });
    const second = createTaskRecord({
      ownerIdentity: "alice",
      input: "Persisted read B",
      executionMode: "parallel_read_only",
      resourceKeys: ["repo:b"],
      now: 2,
    });
    await store.put(first);
    await store.put(second);
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      maxConcurrent: 3,
      trustDeclaredReadOnly: false,
    });
    supervisor.registerOwner("alice", "session-a");
    await supervisor.initialize();

    await waitFor(() => hermes.startCalls.length === 1);
    await settle();
    expect(hermes.startCalls.map((call) => call.input)).toEqual(["Persisted read A"]);
    expect((await store.load(first.taskId))?.status).toBe("running");
    expect((await store.load(second.taskId))?.status).toBe("queued");
    await supervisor.close();
  });

  it("avoids read-only head-of-line blocking while preserving an exclusive FIFO barrier", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({ store, hermes, maxConcurrent: 3, trustDeclaredReadOnly: true });
    await supervisor.initialize();

    const activeA = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Read A first",
      executionMode: "parallel_read_only",
      resourceKeys: ["repo:a"],
    });
    await waitFor(async () => (await store.load(activeA.taskId))?.status === "running");
    const blockedA = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Read A second",
      executionMode: "parallel_read_only",
      resourceKeys: ["repo:a"],
    });
    const disjointB = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Read B",
      executionMode: "parallel_read_only",
      resourceKeys: ["repo:b"],
    });

    await waitFor(async () => (await store.load(disjointB.taskId))?.status === "running");
    expect((await store.load(blockedA.taskId))?.status).toBe("queued");

    const exclusive = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Exclusive barrier",
      executionMode: "exclusive",
      resourceKeys: ["repo:release"],
    });
    const laterC = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Read C behind barrier",
      executionMode: "parallel_read_only",
      resourceKeys: ["repo:c"],
    });
    await settle();
    expect((await store.load(exclusive.taskId))?.status).toBe("queued");
    expect((await store.load(laterC.taskId))?.status).toBe("queued");
    await supervisor.close();
  });

  it("enforces a bounded queue and accepts zero as a deliberate submission-off limit", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({ store, hermes, maxConcurrent: 1, maxQueued: 1 });
    await supervisor.initialize();
    await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Long mutation" });
    await waitFor(() => hermes.startCalls.length === 1);
    await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Queued mutation" });
    await expect(supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Overflow mutation",
    })).rejects.toBeInstanceOf(TaskQueueFullError);
    await supervisor.close();

    const disabled = new TaskSupervisor({ store: new MemoryTaskStore(), hermes: new HermesHarness(), maxQueued: 0 });
    await disabled.initialize();
    await expect(disabled.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Disabled",
    })).rejects.toBeInstanceOf(TaskQueueFullError);
    await disabled.close();
  });

  it("restores safely: queued tasks await owner registration, missing runs become unknown, and orphan dispatches fence", async () => {
    const store = new MemoryTaskStore();
    const queued = createTaskRecord({ ownerIdentity: "alice", input: "Resume after reconnect", now: 1 });
    const orphanDispatch = transitionTask(
      createTaskRecord({ ownerIdentity: "bob", input: "Ambiguous dispatch", now: 2 }),
      "dispatching",
      { now: 3 },
    );
    const running = transitionTask(
      transitionTask(createTaskRecord({ ownerIdentity: "carol", input: "Missing run", now: 4 }), "dispatching", { now: 5 }),
      "running",
      { now: 6, runId: "run_missing" },
    );
    await store.put(queued);
    await store.put(orphanDispatch);
    await store.put(running);
    const hermes = new HermesHarness();
    hermes.getBehavior = async (runId) => {
      if (runId === "run_missing") throw Object.assign(new Error("gone"), { status: 404 });
      return hermes.snapshot(runId);
    };
    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();

    expect(hermes.startCalls).toHaveLength(0);
    expect(await store.load(orphanDispatch.taskId)).toMatchObject({
      status: "dispatch_unknown",
      notification: { unread: true },
    });
    const missing = (await store.load(running.taskId))!;
    expect(missing).toMatchObject({
      status: "unknown",
      upstreamRunMissingAt: expect.any(Number),
      notification: { unread: true },
    });
    expect(hermes.streamCalls).toHaveLength(0);
    const writesBeforeMissingStop = store.writes.length;
    await expect(supervisor.stop(hashTaskOwnerId("carol"), running.taskId)).resolves.toEqual(missing);
    expect(store.writes).toHaveLength(writesBeforeMissingStop);
    expect(hermes.stopCalls).toEqual([]);
    expect(hermes.streamCalls).toEqual([]);

    supervisor.registerOwner("alice", "session-a");
    await settle();
    // dispatch_unknown is intentionally an admission fence because its missing
    // run id makes duplicate mutating work impossible to rule out.
    expect(hermes.startCalls).toHaveLength(0);
    expect((await store.load(queued.taskId))?.status).toBe("queued");
    await supervisor.close();
  });

  it("reconciles restart state with four bounded workers while admission remains fenced", async () => {
    const store = new MemoryTaskStore();
    const runningRecords = Array.from({ length: 7 }, (_, index) => transitionTask(
      transitionTask(
        createTaskRecord({ ownerIdentity: "alice", input: `Recovered ${index}`, now: 10 + (index * 3) }),
        "dispatching",
        { now: 11 + (index * 3) },
      ),
      "running",
      { now: 12 + (index * 3), runId: `run_recovered_${index}` },
    ));
    for (const record of runningRecords) await store.put(record);

    const hermes = new HermesHarness();
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    hermes.getBehavior = async (runId) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { object: "hermes.run", run_id: runId, status: "running" };
      } finally {
        active -= 1;
      }
    };
    const supervisor = new TaskSupervisor({ store, hermes });
    const initializing = supervisor.initialize();

    await waitFor(() => hermes.getCalls.length === 4);
    expect(maximumActive).toBe(4);
    await expect(supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Too early" }))
      .rejects.toThrow("TaskSupervisor.initialize() must complete before use.");
    releases.splice(0).forEach((release) => release());
    await waitFor(() => hermes.getCalls.length === 7);
    expect(maximumActive).toBe(4);
    releases.splice(0).forEach((release) => release());
    await initializing;

    expect(hermes.getCalls).toHaveLength(7);
    expect(hermes.streamCalls).toHaveLength(7);
    await supervisor.close();
  });

  it("waits for startup reconciliation to observe shutdown before closing task state", async () => {
    const store = new MemoryTaskStore();
    const running = transitionTask(
      transitionTask(createTaskRecord({ ownerIdentity: "alice", input: "Recover then close", now: 1 }), "dispatching", { now: 2 }),
      "running",
      { now: 3, runId: "run_close_during_startup" },
    );
    await store.put(running);
    const hermes = new HermesHarness();
    hermes.getBehavior = async (_runId, options) => await new Promise<never>((_resolve, reject) => {
      const signal = requestSignal(options);
      signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("reconciliation aborted"), { name: "AbortError" }));
      }, { once: true });
    });
    const supervisor = new TaskSupervisor({ store, hermes });
    const initializing = supervisor.initialize();
    await waitFor(() => hermes.getCalls.length === 1);

    await supervisor.close();
    await expect(initializing).resolves.toBeUndefined();
    expect(hermes.streamCalls).toEqual([]);
  });

  it("retries only structured 429/503 rejections and never retries an ambiguous POST", async () => {
    const scheduler = new ManualScheduler();
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    let starts = 0;
    hermes.startBehavior = async () => {
      starts += 1;
      if (starts === 1) {
        throw Object.assign(new Error("busy"), { status: 503, errorCode: "gateway_draining" });
      }
      return { runId: "run_retry", status: "queued" };
    };
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      scheduler,
      now: () => scheduler.now,
      retryBaseMs: 500,
      retryMaxMs: 2_000,
    });
    await supervisor.initialize();
    const task = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Retry me" });
    await waitFor(async () => (await store.load(task.taskId))?.status === "queued" && hermes.startCalls.length === 1);
    scheduler.advanceBy(499);
    await settle();
    expect(hermes.startCalls).toHaveLength(1);
    scheduler.advanceBy(1);
    await waitFor(() => hermes.startCalls.length === 2);
    expect(await store.load(task.taskId)).toMatchObject({ status: "running", runId: "run_retry" });
    await supervisor.close();

    const ambiguousScheduler = new ManualScheduler();
    const ambiguousStore = new MemoryTaskStore();
    const ambiguousHermes = new HermesHarness();
    ambiguousHermes.startBehavior = async () => {
      throw new Error("socket reset at 127.0.0.1:8000");
    };
    const ambiguous = new TaskSupervisor({
      store: ambiguousStore,
      hermes: ambiguousHermes,
      scheduler: ambiguousScheduler,
      now: () => ambiguousScheduler.now,
    });
    await ambiguous.initialize();
    const uncertain = await ambiguous.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Do once" });
    await waitFor(async () => (await ambiguousStore.load(uncertain.taskId))?.status === "dispatch_unknown");
    ambiguousScheduler.advanceBy(60_000);
    await settle();
    expect(ambiguousHermes.startCalls).toHaveLength(1);
    await ambiguous.close();
  });

  it("does not requeue when stop intent wins a definitive-rejection write race", async () => {
    const scheduler = new ManualScheduler();
    const store = new StopBeforeRequeueStore();
    const hermes = new HermesHarness();
    hermes.startBehavior = async () => {
      throw Object.assign(new Error("busy"), { status: 503, errorCode: "gateway_draining" });
    };
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      scheduler,
      now: () => scheduler.now,
      retryBaseMs: 10,
      retryMaxMs: 10,
    });
    await supervisor.initialize();
    const task = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Cancel if Hermes is draining",
    });

    await waitFor(async () => (await store.load(task.taskId))?.status === "cancelled");
    expect(await store.load(task.taskId)).toMatchObject({
      status: "cancelled",
      stopRequestedAt: expect.any(Number),
    });
    scheduler.advanceBy(60_000);
    await settle();
    expect(hermes.startCalls).toHaveLength(1);
    await supervisor.close();
  });

  it.each([
    [429, undefined],
    [429, "proxy_rate_limit"],
    [500, undefined],
    [502, undefined],
    [503, undefined],
    [504, undefined],
  ])("fences an HTTP %i dispatch without Hermes' definitive pre-admission code", async (status, errorCode) => {
    const scheduler = new ManualScheduler();
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    hermes.startBehavior = async () => {
      throw Object.assign(new Error("ambiguous response"), { status, ...(errorCode ? { errorCode } : {}) });
    };
    const supervisor = new TaskSupervisor({ store, hermes, scheduler, now: () => scheduler.now });
    await supervisor.initialize();
    const task = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Do exactly once" });

    await waitFor(async () => (await store.load(task.taskId))?.status === "dispatch_unknown");
    scheduler.advanceBy(60_000);
    await settle();
    expect(hermes.startCalls).toHaveLength(1);
    await supervisor.close();
  });

  it.each([
    [429, "rate_limit_exceeded"],
    [503, "gateway_draining"],
  ])("retries an HTTP %i dispatch only with Hermes pre-admission code %s", async (status, errorCode) => {
    const scheduler = new ManualScheduler();
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    let starts = 0;
    hermes.startBehavior = async () => {
      starts += 1;
      if (starts === 1) throw Object.assign(new Error("definitive rejection"), { status, errorCode });
      return { runId: `run_${status}`, status: "started" };
    };
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      scheduler,
      now: () => scheduler.now,
      retryBaseMs: 10,
      retryMaxMs: 10,
    });
    await supervisor.initialize();
    const task = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Retry safely" });

    await waitFor(async () => (await store.load(task.taskId))?.status === "queued" && hermes.startCalls.length === 1);
    scheduler.advanceBy(10);
    await waitFor(async () => (await store.load(task.taskId))?.status === "running");
    expect(hermes.startCalls).toHaveLength(2);
    await supervisor.close();
  });

  it("polls while SSE stays open, persists terminal output before publication, and confirms stop asynchronously", async () => {
    const scheduler = new ManualScheduler();
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      scheduler,
      now: () => scheduler.now,
      pollIntervalMs: 100,
    });
    await supervisor.initialize();
    const ownerId = supervisor.registerOwner("alice", "session-a");
    const published: Array<{ status: string; persistedStatus?: string; output?: string }> = [];
    supervisor.subscribe(ownerId, (record) => {
      published.push({
        status: record.status,
        persistedStatus: store.peek(record.taskId)?.status,
        output: record.output,
      });
    });
    const task = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Watch me" });
    await waitFor(async () => (await store.load(task.taskId))?.status === "running");
    const runId = (await store.load(task.taskId))!.runId!;
    expect(hermes.streamCalls).toEqual([runId]);

    scheduler.advanceBy(100);
    await waitFor(() => hermes.getCalls.includes(runId));
    expect((await store.load(task.taskId))?.status).toBe("running");

    const stopping = await supervisor.stop(ownerId, task.taskId);
    expect(stopping.status).toBe("stopping");
    expect(hermes.stopCalls).toEqual([runId]);
    expect((await store.load(task.taskId))?.status).toBe("stopping");

    hermes.setSnapshot(runId, {
      object: "hermes.run",
      run_id: runId,
      status: "completed",
      output: "final retained output",
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
    });
    scheduler.advanceBy(100);
    await waitFor(async () => (await store.load(task.taskId))?.status === "completed");
    expect(await store.load(task.taskId)).toMatchObject({
      output: "final retained output",
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
    });
    expect(published.at(-1)).toEqual({
      status: "completed",
      persistedStatus: "completed",
      output: "final retained output",
    });
    await supervisor.close();
  });

  it("retries a transient confirmed-missing state write and clears degraded readiness after persistence", async () => {
    const scheduler = new ManualScheduler();
    const store = new FailOnceMissingRunStore();
    const hermes = new HermesHarness();
    hermes.getBehavior = async () => {
      throw Object.assign(new Error("run not found"), { status: 404 });
    };
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      scheduler,
      now: () => scheduler.now,
      pollIntervalMs: 100,
    });
    await supervisor.initialize();
    const task = await supervisor.submit({
      ownerIdentity: "alice",
      sessionKey: "session-a",
      input: "Reconcile a disappearing run",
    });
    await waitFor(async () => (await store.load(task.taskId))?.status === "running");

    scheduler.advanceBy(100);
    await waitFor(() => store.failedMissingRunWrite);
    await expect(supervisor.health()).rejects.toThrow("Durable task state could not be updated");
    expect((await store.load(task.taskId))?.status).toBe("running");

    scheduler.advanceBy(100);
    await waitFor(async () => (await store.load(task.taskId))?.upstreamRunMissingAt !== undefined);
    await expect(supervisor.health()).resolves.toBeUndefined();
    expect(hermes.getCalls.length).toBeGreaterThanOrEqual(2);
    await supervisor.close();
  });

  it("retains a bounded SSE completion prefix and records upstream truncation", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();
    const task = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Generate long output" });
    await waitFor(async () => (await store.load(task.taskId))?.status === "running");
    const runId = (await store.load(task.taskId))!.runId!;

    hermes.pushEvent(runId, {
      event: "run.completed",
      run_id: runId,
      output: "x".repeat(200_007),
    });

    await waitFor(async () => (await store.load(task.taskId))?.status === "completed");
    expect(await store.load(task.taskId)).toMatchObject({
      output: "x".repeat(200_000),
      outputTruncated: true,
    });
    await supervisor.close();
  });

  it("honors a stop requested while Hermes dispatch is still in flight", async () => {
    const deferred = deferredValue<StartRunResult>();
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    hermes.startBehavior = () => deferred.promise;
    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();
    const ownerId = supervisor.registerOwner("alice", "session-a");
    const task = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Dispatch slowly" });
    await waitFor(async () => (await store.load(task.taskId))?.status === "dispatching");

    const stopReceipt = await supervisor.stop(ownerId, task.taskId);
    expect(stopReceipt.status).toBe("dispatching");
    expect(stopReceipt.stopRequestedAt).toEqual(expect.any(Number));
    deferred.resolve({ runId: "run_slow_dispatch", status: "started" });

    await waitFor(() => hermes.stopCalls.includes("run_slow_dispatch"));
    expect((await store.load(task.taskId))?.status).toBe("stopping");
    await supervisor.close();
  });

  it("retries an ambiguous exact stop without ever resuming ordinary running state", async () => {
    const scheduler = new ManualScheduler();
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    let stopAttempts = 0;
    hermes.stopBehavior = async (runId) => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error("socket reset before the stop response");
      return { run_id: runId, status: "stopping" };
    };
    const supervisor = new TaskSupervisor({
      store,
      hermes,
      scheduler,
      now: () => scheduler.now,
      pollIntervalMs: 100,
    });
    await supervisor.initialize();
    const ownerId = supervisor.registerOwner("alice", "session-a");
    const task = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Stop safely" });
    await waitFor(async () => (await store.load(task.taskId))?.status === "running");
    const runId = (await store.load(task.taskId))!.runId!;

    const uncertain = await supervisor.stop(ownerId, task.taskId);
    expect(uncertain).toMatchObject({
      status: "unknown",
      runId,
      stopRequestedAt: expect.any(Number),
    });
    expect(hermes.stopCalls).toEqual([runId]);

    scheduler.advanceBy(100);
    await waitFor(() => hermes.stopCalls.length === 2);
    const retried = (await store.load(task.taskId))!;
    expect(retried).toMatchObject({ status: "stopping", runId });
    expect(retried.stopRequestedAt).toBe(uncertain.stopRequestedAt);
    expect(store.writes
      .filter((record) => record.revision > uncertain.revision)
      .some((record) => record.status === "running")).toBe(false);
    await supervisor.close();
  });

  it("replays a persisted exact-stop intent after a supervisor restart", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    let stopAttempts = 0;
    hermes.stopBehavior = async (runId) => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error("connection closed before the stop acknowledgement");
      return { run_id: runId, status: "stopping" };
    };
    const first = new TaskSupervisor({ store, hermes });
    await first.initialize();
    const ownerId = first.registerOwner("alice", "session-a");
    const task = await first.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Survive restart" });
    await waitFor(async () => (await store.load(task.taskId))?.status === "running");
    const runId = (await store.load(task.taskId))!.runId!;
    const uncertain = await first.stop(ownerId, task.taskId);
    expect(uncertain).toMatchObject({ status: "unknown", stopRequestedAt: expect.any(Number) });
    await first.close();

    hermes.setSnapshot(runId, { object: "hermes.run", run_id: runId, status: "running" });
    const restarted = new TaskSupervisor({ store, hermes });
    restarted.registerOwner("alice", "session-a");
    await restarted.initialize();

    await waitFor(() => hermes.stopCalls.length === 2);
    const recovered = (await store.load(task.taskId))!;
    expect(recovered).toMatchObject({ status: "stopping", runId });
    expect(recovered.stopRequestedAt).toBe(uncertain.stopRequestedAt);
    await restarted.close();
  });

  it("denies every v0.5 approval fail-closed, including events carrying an id, without retaining raw payloads", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();
    const task = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Potentially dangerous" });
    await waitFor(async () => (await store.load(task.taskId))?.status === "running");
    const runId = (await store.load(task.taskId))!.runId!;
    hermes.pushEvent(runId, {
      event: "approval.request",
      run_id: runId,
      approval_id: "approval_upstream_1",
      command: "RAW_SECRET_COMMAND",
      reasoning: "RAW_SECRET_REASONING",
    });

    await waitFor(async () => (await store.load(task.taskId))?.status === "stopping");
    expect(hermes.approvalCalls).toEqual([{
      runId,
      choice: "deny",
      options: expect.objectContaining({ resolveAll: true }),
    }]);
    expect(hermes.stopCalls).toEqual([runId]);
    const serialized = JSON.stringify(await store.load(task.taskId));
    expect(serialized).not.toContain("RAW_SECRET_COMMAND");
    expect(serialized).not.toContain("RAW_SECRET_REASONING");
    // Approval containment is still in progress, so there is no actionable or
    // terminal inbox item yet. The eventual cancelled/failed/unknown outcome
    // creates its own durable notification.
    expect(await store.load(task.taskId)).toMatchObject({ notification: { unread: false } });
    await supervisor.close();
  });

  it("keeps notifications durable with idempotent announce/ack and enforces exact owner scope", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();
    const ownerId = supervisor.registerOwner("alice", "session-a");
    const task = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Finish" });
    await waitFor(async () => (await store.load(task.taskId))?.status === "running");
    const runId = (await store.load(task.taskId))!.runId!;
    hermes.pushEvent(runId, { event: "run.completed", run_id: runId, output: "done" });
    await waitFor(async () => (await store.load(task.taskId))?.status === "completed");
    const terminal = (await store.load(task.taskId))!;
    expect(terminal.notification.unread).toBe(true);

    const announced = await supervisor.markNotificationAnnounced(ownerId, task.taskId);
    const announcedAgain = await supervisor.markNotificationAnnounced(ownerId, task.taskId);
    expect(announcedAgain.revision).toBe(announced.revision);
    expect(announced.notification).toMatchObject({ unread: true, announcedAt: expect.any(Number) });

    const acknowledged = await supervisor.acknowledgeNotification(ownerId, task.taskId);
    const acknowledgedAgain = await supervisor.acknowledgeNotification(ownerId, task.taskId);
    expect(acknowledgedAgain.revision).toBe(acknowledged.revision);
    expect(acknowledged.notification).toMatchObject({ unread: false, acknowledgedAt: expect.any(Number) });

    const otherOwner = supervisor.registerOwner("mallory", "session-m");
    await expect(supervisor.get(otherOwner, task.taskId)).resolves.toBeUndefined();
    await expect(supervisor.stop(otherOwner, task.taskId)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(supervisor.stop(ownerId, `task_${"0".repeat(32)}`)).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(supervisor.health()).resolves.toBeUndefined();
    await supervisor.close();
  });

  it("queries every retained active task and unread notification independently of recent-history limits", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const active = createTaskRecord({ ownerIdentity: "alice", input: "Old active task", now: 1 });
    const unread = transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Old unread task", now: 2 }),
      "cancelled",
      { now: 3 },
    );
    const recentOne = acknowledgeTaskNotification(transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Recent task one", now: 10 }),
      "cancelled",
      { now: 11 },
    ), 12);
    const recentTwo = acknowledgeTaskNotification(transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Recent task two", now: 20 }),
      "cancelled",
      { now: 21 },
    ), 22);
    const otherOwner = transitionTask(
      createTaskRecord({ ownerIdentity: "mallory", input: "Other owner unread", now: 30 }),
      "cancelled",
      { now: 31 },
    );
    for (const record of [active, unread, recentOne, recentTwo, otherOwner]) await store.put(record);

    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();
    const ownerId = hashTaskOwnerId("alice");

    expect((await supervisor.list(ownerId, 2)).map((task) => task.taskId)).toEqual([
      recentTwo.taskId,
      recentOne.taskId,
    ]);
    // Callers can fetch limit + 1 and compare lengths instead of treating an
    // exactly-full page as proof that more history exists.
    expect(await supervisor.list(ownerId, 3)).toHaveLength(3);
    expect((await supervisor.listActive(ownerId)).map((task) => task.taskId)).toEqual([active.taskId]);
    expect((await supervisor.listUnreadNotifications(ownerId)).map((task) => task.taskId)).toEqual([unread.taskId]);

    await supervisor.close();
  });

  it("leases notification speech to one session and persists it only after provider handoff", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const terminal = transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Speak once", now: 1 }),
      "cancelled",
      { now: 2 },
    );
    await store.put(terminal);
    const supervisor = new TaskSupervisor({ store, hermes, now: () => 10 });
    await supervisor.initialize();
    const ownerId = hashTaskOwnerId("alice");

    const claims = await Promise.all([
      supervisor.claimNotificationAnnouncement(ownerId, terminal.taskId, "live_11111111111111111111111111111111"),
      supervisor.claimNotificationAnnouncement(ownerId, terminal.taskId, "live_22222222222222222222222222222222"),
    ]);

    expect(claims.map((claim) => claim.claimed)).toEqual([true, false]);
    expect(claims[0]!.task.notification.announcedAt).toBeUndefined();
    expect(claims[1]!.task.notification.announcedAt).toBeUndefined();
    expect((await store.load(terminal.taskId))!.revision).toBe(terminal.revision);

    const announced = await supervisor.completeNotificationAnnouncement(
      ownerId,
      terminal.taskId,
      "live_11111111111111111111111111111111",
    );
    expect(announced.notification.announcedAt).toBe(10);
    const persisted = (await store.load(terminal.taskId))!;
    expect(persisted.events.filter((event) => event.type === "notification.announced")).toHaveLength(1);
    expect(persisted.revision).toBe(terminal.revision + 1);

    await expect(supervisor.claimNotificationAnnouncement(
      hashTaskOwnerId("mallory"),
      terminal.taskId,
      "live_33333333333333333333333333333333",
    )).rejects.toBeInstanceOf(TaskNotFoundError);
    await supervisor.close();
  });

  it("releases an uncompleted notification lease for another live session", async () => {
    const store = new MemoryTaskStore();
    const terminal = transitionTask(
      createTaskRecord({ ownerIdentity: "alice", input: "Retry speech", now: 1 }),
      "cancelled",
      { now: 2 },
    );
    await store.put(terminal);
    const supervisor = new TaskSupervisor({ store, hermes: new HermesHarness() });
    await supervisor.initialize();
    const ownerId = hashTaskOwnerId("alice");
    const first = "live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const second = "live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    await expect(supervisor.claimNotificationAnnouncement(ownerId, terminal.taskId, first)).resolves
      .toMatchObject({ claimed: true });
    await expect(supervisor.claimNotificationAnnouncement(ownerId, terminal.taskId, second)).resolves
      .toMatchObject({ claimed: false });
    supervisor.releaseNotificationAnnouncement(ownerId, terminal.taskId, first);
    await expect(supervisor.claimNotificationAnnouncement(ownerId, terminal.taskId, second)).resolves
      .toMatchObject({ claimed: true });
    expect((await store.load(terminal.taskId))!.notification.announcedAt).toBeUndefined();

    await supervisor.close();
  });

  it("cancels queued tasks locally and closing never stops live Hermes runs", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({ store, hermes, maxConcurrent: 1 });
    await supervisor.initialize();
    const ownerId = supervisor.registerOwner("alice", "session-a");
    const active = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Active" });
    await waitFor(async () => (await store.load(active.taskId))?.status === "running");
    const queued = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Queued" });
    const cancelled = await supervisor.stop(ownerId, queued.taskId);
    expect(cancelled.status).toBe("cancelled");
    expect(hermes.stopCalls).toHaveLength(0);

    await supervisor.close();
    expect(hermes.stopCalls).toHaveLength(0);
    expect((await store.load(active.taskId))?.status).toBe("running");
  });

  it("treats an operator-contained unknown task as operationally closed", async () => {
    const store = new MemoryTaskStore();
    const running = transitionTask(
      transitionTask(createTaskRecord({ ownerIdentity: "alice", input: "Unknown effect", now: 1 }), "dispatching", { now: 2 }),
      "running",
      { now: 3, runId: "run_contained" },
    );
    const contained = containIndeterminateTask(
      transitionTask(running, "unknown", { now: 4, summary: "Outcome could not be confirmed." }),
      5,
    );
    await store.put(contained);
    const hermes = new HermesHarness();
    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();
    const ownerId = hashTaskOwnerId("alice");
    const writesBeforeStop = store.writes.length;

    await expect(supervisor.stop(ownerId, contained.taskId, "try again")).resolves.toEqual(contained);
    await expect(supervisor.stop(ownerId, contained.taskId)).resolves.toEqual(contained);
    expect(store.writes).toHaveLength(writesBeforeStop);
    expect(hermes.stopCalls).toEqual([]);
    expect(hermes.getCalls).toEqual([]);
    expect(hermes.streamCalls).toEqual([]);
    expect(await supervisor.listActive(ownerId)).toEqual([]);

    await supervisor.close();
  });

  it("waits for an in-flight dispatch abort to persist its ambiguous outcome before close returns", async () => {
    const store = new MemoryTaskStore();
    const hermes = new HermesHarness();
    hermes.startBehavior = async (_params, signal) => await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("dispatch aborted"), { name: "AbortError" }));
      }, { once: true });
    });
    const supervisor = new TaskSupervisor({ store, hermes });
    await supervisor.initialize();
    const task = await supervisor.submit({ ownerIdentity: "alice", sessionKey: "session-a", input: "Slow dispatch" });
    await waitFor(async () => (await store.load(task.taskId))?.status === "dispatching");

    await supervisor.close();

    expect((await store.load(task.taskId))?.status).toBe("dispatch_unknown");
  });
});

class MemoryTaskStore implements TaskStorePort {
  private readonly records = new Map<string, TaskRecord>();
  readonly writes: TaskRecord[] = [];

  async load(taskId: string): Promise<TaskRecord | undefined> {
    return clone(this.records.get(taskId));
  }

  async list(options: TaskListOptions = {}): Promise<TaskRecord[]> {
    const statuses = options.statuses ? new Set(options.statuses) : undefined;
    const records = [...this.records.values()]
      .filter((record) => !options.ownerId || record.ownerId === options.ownerId)
      .filter((record) => !statuses || statuses.has(record.status))
      .filter((record) => options.notificationUnread === undefined
        || record.notification.unread === options.notificationUnread)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId))
      .slice(0, options.limit ?? this.records.size)
      .map((record) => clone(record)!);
    return records;
  }

  async put(value: TaskRecord): Promise<TaskRecord> {
    const record = parseTaskRecord(value);
    if (this.records.has(record.taskId)) throw Object.assign(new Error("conflict"), { name: "TaskStoreConflictError" });
    this.records.set(record.taskId, clone(record)!);
    this.writes.push(clone(record)!);
    return clone(record)!;
  }

  async update(
    taskId: string,
    updater: (current: TaskRecord) => TaskRecord,
    options: TaskUpdateOptions = {},
  ): Promise<TaskRecord> {
    const current = this.records.get(taskId);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      throw Object.assign(new Error("conflict"), { name: "TaskStoreConflictError" });
    }
    const updated = parseTaskRecord(updater(clone(current)!));
    if (updated.revision === current.revision) return clone(current)!;
    if (updated.revision !== current.revision + 1) throw new Error("invalid revision");
    this.records.set(taskId, clone(updated)!);
    this.writes.push(clone(updated)!);
    return clone(updated)!;
  }

  async delete(taskId: string): Promise<boolean> {
    return this.records.delete(taskId);
  }

  async prune(_options?: TaskPruneOptions): Promise<TaskPruneResult> {
    return { deleted: 0, taskIds: [] };
  }

  peek(taskId: string): TaskRecord | undefined {
    return this.records.get(taskId);
  }
}

class FailOnceAcceptedRunStore extends MemoryTaskStore {
  private failed = false;

  override async update(
    taskId: string,
    updater: (current: TaskRecord) => TaskRecord,
    options: TaskUpdateOptions = {},
  ): Promise<TaskRecord> {
    const current = await this.load(taskId);
    if (current && !this.failed) {
      const candidate = updater(current);
      if (current.status === "dispatching" && candidate.status === "running" && candidate.runId) {
        this.failed = true;
        throw new Error("transient pre-rename task-state write failure");
      }
    }
    return super.update(taskId, updater, options);
  }
}

class GateAcceptedRunStore extends MemoryTaskStore {
  allowAcceptedRunWrites = false;
  rejectedAcceptedRunWrites = 0;
  closeCalls = 0;
  closeFailure?: Error;

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeFailure) throw this.closeFailure;
  }

  override async update(
    taskId: string,
    updater: (current: TaskRecord) => TaskRecord,
    options: TaskUpdateOptions = {},
  ): Promise<TaskRecord> {
    const current = await this.load(taskId);
    if (current) {
      const candidate = updater(current);
      if (
        !this.allowAcceptedRunWrites
        && current.status === "dispatching"
        && candidate.status === "running"
        && candidate.runId
      ) {
        this.rejectedAcceptedRunWrites += 1;
        throw new Error("accepted run persistence remains unavailable");
      }
    }
    return super.update(taskId, updater, options);
  }
}

class FailOnceMissingRunStore extends MemoryTaskStore {
  failedMissingRunWrite = false;

  override async update(
    taskId: string,
    updater: (current: TaskRecord) => TaskRecord,
    options: TaskUpdateOptions = {},
  ): Promise<TaskRecord> {
    const current = await this.load(taskId);
    if (current && !this.failedMissingRunWrite) {
      const candidate = updater(current);
      if (candidate.upstreamRunMissingAt !== undefined) {
        this.failedMissingRunWrite = true;
        throw new Error("transient confirmed-missing state write failure");
      }
    }
    return super.update(taskId, updater, options);
  }
}

class StopBeforeRequeueStore extends MemoryTaskStore {
  private injected = false;

  override async update(
    taskId: string,
    updater: (current: TaskRecord) => TaskRecord,
    options: TaskUpdateOptions = {},
  ): Promise<TaskRecord> {
    const current = await this.load(taskId);
    if (current && !this.injected) {
      const candidate = updater(current);
      if (
        current.status === "dispatching"
        && current.stopRequestedAt === undefined
        && candidate.status === "queued"
      ) {
        this.injected = true;
        await super.update(
          taskId,
          (record) => markTaskStopRequested(record, {
            now: record.updatedAt,
            summary: "Exact task stop requested while dispatch was in flight.",
          }),
          options,
        );
      }
    }
    return super.update(taskId, updater, options);
  }
}

class HermesHarness implements HermesRunsPort {
  readonly baseUrl = "http://hermes.test";
  readonly startCalls: StartRunParams[] = [];
  readonly getCalls: string[] = [];
  readonly stopCalls: string[] = [];
  readonly streamCalls: string[] = [];
  readonly approvalCalls: Array<{
    runId: string;
    choice: ApprovalChoice;
    options?: { approvalId?: string; resolveAll?: boolean; signal?: AbortSignal; sessionKey?: string };
  }> = [];
  startBehavior?: (params: StartRunParams, signal?: AbortSignal) => Promise<StartRunResult>;
  getBehavior?: (runId: string, options?: AbortSignal | HermesRequestOptions) => Promise<HermesRunSnapshot>;
  stopBehavior?: (
    runId: string,
    options?: AbortSignal | HermesRequestOptions,
  ) => Promise<{ run_id: string; status: "stopping" }>;
  private runCounter = 0;
  private readonly snapshots = new Map<string, HermesRunSnapshot>();
  private readonly streams = new Map<string, EventQueue>();

  async health(_signal?: AbortSignal): Promise<Record<string, unknown>> {
    return { ok: true };
  }

  async capabilities(_signal?: AbortSignal): Promise<HermesCapabilities> {
    return { features: {} };
  }

  async assertRunsSupported(_signal?: AbortSignal): Promise<HermesCapabilities> {
    return this.capabilities();
  }

  async startRun(params: StartRunParams, signal?: AbortSignal): Promise<StartRunResult> {
    this.startCalls.push(structuredClone(params));
    const result = this.startBehavior
      ? await this.startBehavior(params, signal)
      : { runId: `run_${++this.runCounter}`, status: "queued" };
    if (!this.snapshots.has(result.runId)) {
      this.setSnapshot(result.runId, { object: "hermes.run", run_id: result.runId, status: "running" });
    }
    this.queue(result.runId);
    return result;
  }

  async getRun(runId: string, options?: AbortSignal | HermesRequestOptions): Promise<HermesRunSnapshot> {
    this.getCalls.push(runId);
    if (this.getBehavior) return this.getBehavior(runId, options);
    return this.snapshot(runId);
  }

  async stopRun(runId: string, options?: AbortSignal | HermesRequestOptions): Promise<{ run_id: string; status: "stopping" }> {
    this.stopCalls.push(runId);
    const result = this.stopBehavior
      ? await this.stopBehavior(runId, options)
      : { run_id: runId, status: "stopping" as const };
    this.setSnapshot(runId, { object: "hermes.run", run_id: runId, status: "stopping" });
    return result;
  }

  async submitApproval(
    runId: string,
    choice: ApprovalChoice,
    options?: { approvalId?: string; resolveAll?: boolean; signal?: AbortSignal; sessionKey?: string },
  ): Promise<ApprovalResult> {
    this.approvalCalls.push({ runId, choice, options });
    return { run_id: runId, choice, resolved: 1 };
  }

  streamRunEvents(runId: string, options?: AbortSignal | HermesRequestOptions): AsyncGenerator<HermesRunEvent> {
    this.streamCalls.push(runId);
    return this.queue(runId).iterate(requestSignal(options));
  }

  pushEvent(runId: string, event: HermesRunEvent): void {
    this.queue(runId).push(event);
  }

  setSnapshot(runId: string, snapshot: HermesRunSnapshot): void {
    this.snapshots.set(runId, structuredClone(snapshot));
  }

  snapshot(runId: string): HermesRunSnapshot {
    return structuredClone(this.snapshots.get(runId)
      ?? { object: "hermes.run", run_id: runId, status: "running" });
  }

  private queue(runId: string): EventQueue {
    const existing = this.streams.get(runId);
    if (existing) return existing;
    const created = new EventQueue();
    this.streams.set(runId, created);
    return created;
  }
}

class EventQueue {
  private readonly values: HermesRunEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<HermesRunEvent>) => void> = [];
  private closed = false;

  push(event: HermesRunEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.values.push(event);
  }

  async *iterate(signal?: AbortSignal): AsyncGenerator<HermesRunEvent> {
    while (!this.closed && !signal?.aborted) {
      const result = await this.next(signal);
      if (result.done) return;
      yield result.value;
    }
  }

  private next(signal?: AbortSignal): Promise<IteratorResult<HermesRunEvent>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.closed || signal?.aborted) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      const complete = (result: IteratorResult<HermesRunEvent>) => {
        signal?.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () => {
        const index = this.waiters.indexOf(complete);
        if (index >= 0) this.waiters.splice(index, 1);
        complete({ done: true, value: undefined });
      };
      this.waiters.push(complete);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

class ManualScheduler implements TaskSupervisorScheduler {
  now = 0;
  private nextId = 1;
  private readonly jobs = new Map<number, { due: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.jobs.set(id, { due: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.jobs.delete(handle as number);
  }

  advanceBy(milliseconds: number): void {
    this.now += milliseconds;
    while (true) {
      const due = [...this.jobs.entries()]
        .filter(([, job]) => job.due <= this.now)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0]);
      if (due.length === 0) return;
      const [id, job] = due[0]!;
      this.jobs.delete(id);
      job.callback();
    }
  }
}

function requestSignal(options?: AbortSignal | HermesRequestOptions): AbortSignal | undefined {
  return options instanceof AbortSignal ? options : options?.signal;
}

function clone(record: TaskRecord | undefined): TaskRecord | undefined {
  return record ? structuredClone(record) : undefined;
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function settle(iterations = 12): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for task-supervisor test condition.");
}
