import { describe, expect, it } from "vitest";
import {
  MAX_TASK_EVENTS,
  MAX_TASK_OUTPUT_CHARS,
  TaskRecordSchema,
  TaskTransitionError,
  acknowledgeTaskNotification,
  appendTaskEvent,
  canTransitionTask,
  createTaskRecord,
  hashTaskOwnerId,
  hermesSessionIdForTask,
  isTaskTerminal,
  markTaskNotificationAnnounced,
  markTaskStopRequested,
  sanitizeTaskOutput,
  sanitizeTaskUsage,
  transitionTask,
} from "../src/domain/tasks/index.js";

describe("task domain", () => {
  it("creates stable opaque task, owner, and Hermes session identities", () => {
    const task = createTaskRecord({
      ownerIdentity: "profile:default:user:voice",
      input: "Review the authentication changes.",
      resourceKeys: ["repo:hermes-live", "repo:hermes-live"],
      now: 100,
    });

    expect(task.taskId).toMatch(/^task_[0-9a-f]{32}$/);
    expect(task.ownerId).toBe(hashTaskOwnerId("profile:default:user:voice"));
    expect(task.ownerId).not.toContain("profile");
    expect(task.hermesSessionId).toBe(hermesSessionIdForTask(task.taskId));
    expect(task.resourceKeys).toEqual(["repo:hermes-live"]);
    expect(task).toMatchObject({
      schemaVersion: 1,
      status: "queued",
      revision: 1,
      sequence: 1,
      notification: { unread: false },
    });
    expect(TaskRecordSchema.parse(task)).toEqual(task);
  });

  it("applies the explicit lifecycle and keeps terminal transitions idempotent", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Run a safe review", now: 100 });
    const dispatching = transitionTask(queued, "dispatching", { now: 110 });
    const running = transitionTask(dispatching, "running", { runId: "run_123", now: 120 });
    const waiting = transitionTask(running, "waiting_for_approval", { now: 130 });
    const resumed = transitionTask(waiting, "running", { now: 140 });
    const completed = transitionTask(resumed, "completed", {
      output: "All checks passed.",
      outputTruncated: true,
      usage: { input_tokens: 12, output_tokens: 4 },
      now: 150,
    });

    expect(completed).toMatchObject({
      status: "completed",
      runId: "run_123",
      revision: 6,
      sequence: 6,
      output: "All checks passed.",
      outputTruncated: true,
      usage: { input_tokens: 12, output_tokens: 4 },
      notification: { unread: true },
    });
    expect(isTaskTerminal(completed.status)).toBe(true);
    expect(transitionTask(completed, "completed")).toEqual(completed);
    expect(transitionTask(completed, "completed").revision).toBe(completed.revision);
    expect(() => transitionTask(completed, "running")).toThrow(TaskTransitionError);
    expect(() => transitionTask(running, "queued")).toThrow(TaskTransitionError);
    expect(canTransitionTask("dispatch_unknown", "running")).toBe(true);
  });

  it("requeues only a definitively rejected dispatch for bounded retry", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Check dependencies", now: 100 });
    const dispatching = transitionTask(queued, "dispatching", { now: 101 });
    const requeued = transitionTask(dispatching, "queued", {
      summary: "Hermes is at capacity; queued for retry.",
      now: 102,
    });

    expect(requeued).toMatchObject({ status: "queued", revision: 3, sequence: 3 });
    expect(requeued.events.at(-1)).toMatchObject({
      type: "queued",
      summary: "Hermes is at capacity; queued for retry.",
    });
    expect(transitionTask(requeued, "dispatching", { now: 103 }).status).toBe("dispatching");
  });

  it("models an ambiguous dispatch separately and never changes an assigned run ID", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Investigate CI", now: 100 });
    const dispatching = transitionTask(queued, "dispatching", { now: 101 });
    const uncertain = transitionTask(dispatching, "dispatch_unknown", {
      error: "Hermes did not confirm task admission.",
      now: 102,
    });
    const recovered = transitionTask(uncertain, "running", { runId: "run_late", now: 103 });

    expect(uncertain.notification.unread).toBe(true);
    expect(recovered.runId).toBe("run_late");
    expect(() => transitionTask(recovered, "stopping", { runId: "run_other" })).toThrow(/immutable/);
  });

  it("withdraws an unread uncertainty notice when exact recovery resumes", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Recover exact state", now: 100 });
    const dispatching = transitionTask(queued, "dispatching", { now: 110 });
    const running = transitionTask(dispatching, "running", { runId: "run_recovered", now: 120 });
    const unknown = transitionTask(running, "unknown", { error: "Ambiguous stop response", now: 130 });
    const waiting = transitionTask(unknown, "waiting_for_approval", { now: 140 });
    const stopping = transitionTask(waiting, "stopping", { now: 150 });

    expect(unknown.notification).toEqual({ unread: true });
    expect(waiting.notification).toEqual({ unread: false });
    expect(stopping.notification).toEqual({ unread: false });
  });

  it("persists an append-only exact-stop intent independently from lifecycle state", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Stop this exact run", now: 10 });
    const running = transitionTask(transitionTask(queued, "dispatching", { now: 11 }), "running", {
      runId: "run_stop_intent",
      now: 12,
    });
    const requested = markTaskStopRequested(running, { now: 13, summary: "User requested an exact stop." });

    expect(requested).toMatchObject({
      status: "running",
      runId: "run_stop_intent",
      stopRequestedAt: 13,
      revision: running.revision + 1,
      sequence: running.sequence + 1,
    });
    expect(requested.events.at(-1)).toMatchObject({
      type: "stop_requested",
      timestamp: 13,
      summary: "User requested an exact stop.",
    });
    expect(markTaskStopRequested(requested, { now: 99 })).toEqual(requested);
    expect(() => TaskRecordSchema.parse({ ...requested, stopRequestedAt: 14 })).toThrow(/task lifetime/);
  });

  it("bounds and sanitizes retained events, output, error, and usage", () => {
    let task = createTaskRecord({ ownerIdentity: "owner", input: "Inspect logs", now: 1 });
    for (let index = 0; index < MAX_TASK_EVENTS + 10; index += 1) {
      task = appendTaskEvent(task, { summary: `progress\u0000 ${index}`, now: index + 2 });
    }
    const failed = transitionTask(transitionTask(task, "dispatching"), "failed", {
      error: "provider\u0000 failed",
      now: 1_000,
    });

    expect(failed.events).toHaveLength(MAX_TASK_EVENTS);
    expect(failed.events.at(-1)?.sequence).toBe(failed.sequence);
    expect(failed.events.some((event) => event.summary?.includes("\u0000"))).toBe(false);
    expect(failed.error).toBe("provider failed");
    expect(sanitizeTaskOutput(`hello\u0000${"x".repeat(MAX_TASK_OUTPUT_CHARS + 10)}`)).toHaveLength(MAX_TASK_OUTPUT_CHARS);
    expect(sanitizeTaskUsage({ input_tokens: 3, nested: {}, "unsafe key": 4, negative: -1 })).toEqual({ input_tokens: 3 });
  });

  it("tracks output truncation only on completed tasks with a retained prefix", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Generate report", now: 1 });
    const dispatching = transitionTask(queued, "dispatching", { now: 2 });
    const running = transitionTask(dispatching, "running", { now: 3, runId: "run_report" });
    const completed = transitionTask(running, "completed", {
      output: "retained prefix",
      outputTruncated: true,
      now: 4,
    });

    expect(completed).toMatchObject({ output: "retained prefix", outputTruncated: true });
    expect(() => transitionTask(running, "failed", { outputTruncated: true })).toThrow(/only when a task completes/);
    expect(() => transitionTask(running, "completed", { outputTruncated: true })).toThrow(/retained output prefix/);
  });

  it("tracks durable notification announcement and acknowledgement idempotently", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Review release", now: 10 });
    const completed = transitionTask(transitionTask(queued, "dispatching", { now: 11 }), "failed", {
      error: "Tests failed",
      now: 12,
    });
    const announced = markTaskNotificationAnnounced(completed, 13);
    const acknowledged = acknowledgeTaskNotification(announced, 14);

    expect(announced.notification).toEqual({ unread: true, announcedAt: 13 });
    expect(acknowledged.notification).toEqual({ unread: false, announcedAt: 13, acknowledgedAt: 14 });
    expect(markTaskNotificationAnnounced(announced, 99)).toEqual(announced);
    expect(acknowledgeTaskNotification(acknowledged, 99)).toEqual(acknowledged);
  });

  it("rejects malformed notification bookkeeping that could change a durable notification id", () => {
    const queued = createTaskRecord({ ownerIdentity: "owner", input: "Review release", now: 10 });
    const failed = transitionTask(transitionTask(queued, "dispatching", { now: 11 }), "failed", {
      error: "Tests failed",
      now: 12,
    });

    expect(() => TaskRecordSchema.parse({
      ...failed,
      events: failed.events.map((event) => event.type === "failed" ? { ...event, type: "progress" as const } : event),
    })).toThrow(/retained transition event/);
    expect(() => TaskRecordSchema.parse({
      ...failed,
      notification: { unread: false },
    })).toThrow(/acknowledgement timestamp/);
    expect(() => TaskRecordSchema.parse({
      ...failed,
      notification: { unread: false, announcedAt: 11, acknowledgedAt: 10 },
    })).toThrow(/cannot precede announcement/);
    expect(() => TaskRecordSchema.parse({ ...failed, updatedAt: 99 })).toThrow(/latest retained event/);
  });

  it("rejects malformed persisted identities and unsafe input", () => {
    expect(() => createTaskRecord({ ownerIdentity: "owner", input: "bad\u0000input" })).toThrow();
    expect(() => createTaskRecord({ ownerIdentity: "owner", input: "bad\u0085input" })).toThrow();
    const task = createTaskRecord({ ownerIdentity: "owner", input: "Safe input", now: 1 });
    expect(() => TaskRecordSchema.parse({ ...task, ownerId: "owner_raw" })).toThrow();
    expect(() => TaskRecordSchema.parse({ ...task, hermesSessionId: "shared-session" })).toThrow();
    expect(() => createTaskRecord({
      ownerIdentity: "owner",
      input: "Safe input",
      resourceKeys: ["repo:safe\u202e"],
    })).toThrow();
    expect(createTaskRecord({
      ownerIdentity: "owner",
      input: "Safe input",
      title: "Release\u202eexe",
    }).title).toBe("Release exe");
  });
});
