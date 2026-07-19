import { describe, expect, it } from "vitest";

import {
  HERMES_LIVE_PROTOCOL_VERSION,
  HERMES_LIVE_TOOL_DECLARATIONS,
  OPENAI_HERMES_LIVE_TOOLS,
  TASK_LIST_DEFAULT_LIMIT,
  assertHermesLiveProtocolVersion,
  incompatibleProtocolVersionMessage,
  parseClientMessage,
  parseServerMessage,
  serverMessage,
} from "../src/protocol.js";

const NOW = 1_784_131_200_000;

describe("protocol v4", () => {
  it("binds v4 sessions to a new, resumed, or unbound Hermes conversation", () => {
    expect(HERMES_LIVE_PROTOCOL_VERSION).toBe(4);
    expect(
      parseClientMessage({
        type: "session.start",
        id: "start_1",
        protocolVersion: 4,
        profileId: "default",
        conversation: { mode: "resume", sessionId: "session_1" },
      }),
    ).toEqual({
      type: "session.start",
      id: "start_1",
      protocolVersion: 4,
      profileId: "default",
      conversation: { mode: "resume", sessionId: "session_1" },
    });
    expect(() => parseClientMessage({
      type: "session.start",
      protocolVersion: 3,
      conversation: { mode: "new" },
    })).toThrow(/requires Hermes Live protocol v4/i);
    expect(() => parseClientMessage({
      type: "session.start",
      protocolVersion: 4,
      conversation: { mode: "resume" },
    })).toThrow(/requires sessionId/i);
  });

  it("keeps v3 compatible and rejects v2 with an actionable error", () => {
    expect(() => assertHermesLiveProtocolVersion(3)).not.toThrow();
    const message = parseClientMessage({ type: "session.start", protocolVersion: 2 });
    expect(message.type).toBe("session.start");
    if (message.type !== "session.start") throw new Error("Expected session.start");
    expect(message.protocolVersion).toBe(2);
    expect(() => assertHermesLiveProtocolVersion(message.protocolVersion)).toThrow(
      /protocol v2 is incompatible with supported protocols v3, v4.*Upgrade hermes-live-voice/i,
    );
    expect(incompatibleProtocolVersionMessage(2)).toContain("before reconnecting");
  });

  it("validates task control commands with exact request and task correlation", () => {
    expect(parseClientMessage({ type: "task.list", id: "list_1" })).toEqual({
      type: "task.list",
      id: "list_1",
      limit: TASK_LIST_DEFAULT_LIMIT,
    });
    expect(parseClientMessage({ type: "task.get", id: "get_1", taskId: "task_1" })).toEqual({
      type: "task.get",
      id: "get_1",
      taskId: "task_1",
    });
    expect(
      parseClientMessage({ type: "task.stop", id: "stop_1", taskId: "task_1", reason: "user cancelled" }),
    ).toMatchObject({ type: "task.stop", id: "stop_1", taskId: "task_1" });
    expect(
      parseClientMessage({
        type: "task.notification.ack",
        id: "ack_1",
        taskId: "task_1",
        notificationId: "notification_1",
      }),
    ).toMatchObject({ type: "task.notification.ack", taskId: "task_1", notificationId: "notification_1" });
  });

  it("keeps audio, text, response cancellation, and detached close messages", () => {
    expect(parseClientMessage({ type: "text.input", text: "hello" }).type).toBe("text.input");
    expect(
      parseClientMessage({
        type: "response.cancel",
        reason: "barge-in",
        truncate: { itemId: "item_1", audioEndMs: 1_200 },
      }),
    ).toMatchObject({
      type: "response.cancel",
      truncate: { itemId: "item_1", contentIndex: 0, audioEndMs: 1_200 },
    });
    expect(parseClientMessage({ type: "session.close", id: "close_1" })).toEqual({
      type: "session.close",
      id: "close_1",
      detach: true,
    });
  });

  it("rejects singleton run controls, dead approval controls, unsafe ids, and unknown fields", () => {
    expect(() => parseClientMessage({ type: "run.stop", runId: "run_1" })).toThrow();
    expect(() =>
      parseClientMessage({
        type: "approval.respond",
        id: "approval_1",
        taskId: "task_1",
        approvalId: "approval_1",
        choice: "once",
      }),
    ).toThrow();
    expect(() =>
      parseClientMessage({
        type: "approval.respond",
        id: "approval_1",
        taskId: "task_1",
        approvalId: "approval_1",
        choice: "once",
        resolveAll: true,
      }),
    ).toThrow();
    expect(() => parseClientMessage({ type: "task.stop", id: "stop 1", taskId: "task_1" })).toThrow();
    expect(() => parseClientMessage({ type: "task.stop", id: "stop_1", taskId: "task 1" })).toThrow();
    expect(() => parseClientMessage({ type: "task.get", taskId: "task_1" })).toThrow();
    expect(() => parseClientMessage({ type: "session.close", detach: false })).toThrow();
    expect(() => parseClientMessage({ type: "session.start", protocolVersion: 3, extra: true })).toThrow();
  });

  it("bounds client-controlled data and sequence cursors", () => {
    expect(() => parseClientMessage({ type: "session.start", protocolVersion: 3, resumeAfter: 1 })).toThrow();
    expect(() => parseClientMessage({ type: "text.input", text: "x".repeat(1_000_001) })).toThrow();
    expect(() => parseClientMessage({ type: "task.list", id: "list_1", limit: 101 })).toThrow();
    expect(() =>
      parseClientMessage({ type: "response.cancel", truncate: { itemId: "item_1", audioEndMs: Number.POSITIVE_INFINITY } }),
    ).toThrow();
    expect(() =>
      parseClientMessage({ type: "response.cancel", truncate: { itemId: "item_1", audioEndMs: 60 * 60 * 1_000 + 1 } }),
    ).toThrow();
  });

  it("exposes owner-scoped task capabilities and truthful snapshot reconnect semantics", () => {
    const ready = parseServerMessage(sessionReady());
    expect(ready).toMatchObject({
      type: "session.ready",
      protocolVersion: 3,
      requestId: "start_1",
      tasks: {
        scope: "owner",
        sequence: "per_task",
        reconnect: "snapshot",
        durable: true,
        parallel: true,
        maxConcurrent: 3,
        supports: { list: true, get: true, stop: true, followUp: true, resume: false, notificationAck: true },
      },
    });
  });

  it("serializes bounded reconnect snapshots with exact request correlation", () => {
    const snapshot = {
      type: "task.snapshot" as const,
      reason: "get" as const,
      requestId: "get_1",
      tasks: [taskSnapshot()],
      truncated: false,
    };

    expect(JSON.parse(serverMessage(parseServerMessage(snapshot)))).toEqual(snapshot);
    expect(() => parseServerMessage({ ...snapshot, requestId: undefined })).toThrow(/get snapshots require requestId/i);
    expect(() => parseServerMessage({ ...snapshot, tasks: [taskSnapshot(), taskSnapshot("task_2")] })).toThrow(
      /at most one task/i,
    );
    expect(() =>
      parseServerMessage({ ...snapshot, tasks: Array.from({ length: 101 }, (_, index) => taskSnapshot(`task_${index}`)) }),
    ).toThrow();
  });

  it("defines every v3 task lifecycle event with stable taskId and a positive sequence", () => {
    const base = { taskId: "task_1", occurredAt: NOW };
    const error = { code: "task_failed", message: "The task failed safely.", recoverable: false };
    const messages = [
      { type: "task.accepted", ...base, sequence: 42, requestId: "request_1", state: "queued" },
      { type: "task.started", ...base, sequence: 43, title: "Review repository" },
      { type: "task.progress", ...base, sequence: 44, progress: { message: "Running tests", current: 1, total: 3 } },
      { type: "task.stopping", ...base, sequence: 47, requestId: "stop_1", reason: "user cancelled" },
      { type: "task.completed", ...base, sequence: 48, result: { summary: "All tests pass.", truncated: false } },
      { type: "task.failed", ...base, sequence: 49, error },
      { type: "task.cancelled", ...base, sequence: 50, reason: "Cancelled by the user." },
      { type: "task.unknown", ...base, sequence: 51, error: { ...error, code: "task_state_unknown" } },
      {
        type: "task.notification",
        ...base,
        sequence: 52,
        notification: {
          notificationId: "notification_1",
          kind: "completed",
          delivery: "when_idle",
          message: "Repository review finished.",
          createdAt: NOW,
          acknowledged: false,
        },
      },
    ];

    for (const message of messages) {
      expect(parseServerMessage(message)).toMatchObject({
        type: message.type,
        taskId: "task_1",
        sequence: message.sequence,
      });
    }
    expect(() => parseServerMessage({ ...messages[1], sequence: 0 })).toThrow(/sequence must be positive/i);
  });

  it("rejects public run events, raw unknown fields, and inconsistent snapshots", () => {
    expect(() => parseServerMessage({ type: "run.started", runId: "run_1", sessionId: "live_1" })).toThrow();
    expect(() => parseServerMessage({
      type: "task.waiting_for_approval",
      taskId: "task_1",
      sequence: 1,
      occurredAt: NOW,
      approval: { approvalId: "approval_1", choices: ["once", "deny"], allowPermanent: false },
    })).toThrow();
    expect(() => parseServerMessage({
      type: "approval.responded",
      taskId: "task_1",
      sequence: 1,
      occurredAt: NOW,
      requestId: "approval_1",
      approvalId: "approval_1",
      choice: "once",
      resolved: 1,
    })).toThrow();
    expect(() => parseServerMessage({
      type: "task.notification",
      taskId: "task_1",
      sequence: 1,
      occurredAt: NOW,
      notification: {
        notificationId: "notification_1",
        kind: "approval_required",
        delivery: "when_idle",
        message: "Approval needed.",
        createdAt: NOW,
        acknowledged: false,
      },
    })).toThrow();
    expect(() =>
      parseServerMessage({
        type: "task.completed",
        taskId: "task_1",
        sequence: 1,
        occurredAt: NOW,
        result: { summary: "Done" },
        runId: "run_private",
      }),
    ).toThrow();
    expect(() =>
      parseServerMessage({
        type: "task.snapshot",
        reason: "initial",
        tasks: [{ ...taskSnapshot(), state: "completed", result: undefined }],
      }),
    ).toThrow(/completed task requires a public result/i);
    expect(() =>
      parseServerMessage({
        type: "task.snapshot",
        reason: "initial",
        tasks: [{ ...taskSnapshot(), sequence: 0 }],
      }),
    ).toThrow(/sequence must be positive/i);
    expect(() =>
      parseServerMessage({
        type: "task.snapshot",
        reason: "initial",
        tasks: [{ ...taskSnapshot(), state: "queued" }],
      }),
    ).not.toThrow();
    expect(() =>
      parseServerMessage({
        type: "task.snapshot",
        reason: "initial",
        tasks: [{ ...taskSnapshot(), state: "queued", queuePosition: 1 }],
      }),
    ).toThrow();
  });

  it("preserves normalized audio, transcript, and response messages", () => {
    expect(parseServerMessage({ type: "transcript.delta", speaker: "assistant", text: "Still working." })).toEqual({
      type: "transcript.delta",
      speaker: "assistant",
      text: "Still working.",
    });
    expect(parseServerMessage({ type: "response.completed", responseId: "response_1" })).toEqual({
      type: "response.completed",
      responseId: "response_1",
    });
  });

  it("exposes only gateway tools to OpenAI Realtime", () => {
    expect(OPENAI_HERMES_LIVE_TOOLS.map((tool) => tool.name)).toEqual([
      "continue_hermes_conversation",
      "start_background_task",
      "list_background_tasks",
      "get_background_task",
      "follow_up_background_task",
      "stop_background_task",
    ]);
    expect(OPENAI_HERMES_LIVE_TOOLS.every((tool) => tool.type === "function")).toBe(true);
    expect(OPENAI_HERMES_LIVE_TOOLS[0]).toHaveProperty("parameters");
    expect(OPENAI_HERMES_LIVE_TOOLS[0]).not.toHaveProperty("parametersJsonSchema");
  });

  it("uses Gemini SDK function declaration schema shape", () => {
    expect(HERMES_LIVE_TOOL_DECLARATIONS.map((tool) => tool.name)).toEqual([
      "continue_hermes_conversation",
      "start_background_task",
      "list_background_tasks",
      "get_background_task",
      "follow_up_background_task",
      "stop_background_task",
    ]);
    expect(HERMES_LIVE_TOOL_DECLARATIONS[0]).toHaveProperty("parametersJsonSchema");
    expect(HERMES_LIVE_TOOL_DECLARATIONS[0]).not.toHaveProperty("parameters");
  });
});

function sessionReady() {
  return {
    type: "session.ready",
    protocolVersion: 3,
    requestId: "start_1",
    sessionId: "live_1",
    model: "mock-live",
    hermes: { model: "hermes-agent", capabilities: { run_submission: true } },
    realtime: {
      provider: "mock",
      model: "mock-live",
      audio: {
        input: { enabled: false },
        output: { enabled: false },
        turnDetection: "none",
      },
    },
    tasks: {
      scope: "owner",
      sequence: "per_task",
      reconnect: "snapshot",
      durable: true,
      parallel: true,
      maxConcurrent: 3,
      maxRetained: 100,
      supports: { list: true, get: true, stop: true, followUp: true, resume: false, notificationAck: true },
    },
  };
}

function taskSnapshot(taskId = "task_1") {
  return {
    taskId,
    sequence: 42,
    state: "running",
    title: "Review repository",
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    progress: { message: "Running tests" },
  };
}
