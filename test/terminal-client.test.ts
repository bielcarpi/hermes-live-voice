import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeGatewayWebSocketUrl,
  sanitizeTerminalText,
  TerminalGatewaySession,
} from "../src/cli/terminal-session.js";
import { HERMES_LIVE_PROTOCOL_VERSION } from "../src/domain/protocol/version.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("terminal gateway URL normalization", () => {
  it("accepts gateway origins and avoids duplicating the live endpoint", () => {
    expect(normalizeGatewayWebSocketUrl("http://127.0.0.1:8788")).toBe("ws://127.0.0.1:8788/v1/live");
    expect(normalizeGatewayWebSocketUrl("https://voice.example/base/")).toBe("wss://voice.example/base/v1/live");
    expect(normalizeGatewayWebSocketUrl("https://voice.example/base/v1/live")).toBe(
      "wss://voice.example/base/v1/live",
    );
    expect(normalizeGatewayWebSocketUrl("ws://voice.example/custom/socket?ticket=one-use")).toBe(
      "ws://voice.example/custom/socket?ticket=one-use",
    );
    expect(normalizeGatewayWebSocketUrl("wss://voice.example")).toBe("wss://voice.example/v1/live");
  });

  it("rejects unsafe or ambiguous URLs", () => {
    expect(() => normalizeGatewayWebSocketUrl("ws://user:secret@voice.example/v1/live")).toThrow(/must not contain credentials/);
    expect(() => normalizeGatewayWebSocketUrl("ws://voice.example/v1/live?token=secret")).toThrow(/token query/);
    expect(() => normalizeGatewayWebSocketUrl("ws://voice.example/v1/live#secret")).toThrow(/fragment/);
    expect(() => normalizeGatewayWebSocketUrl("file:///tmp/socket")).toThrow(/http, https, ws, or wss/);
    expect(() => normalizeGatewayWebSocketUrl("not a url")).toThrow(/absolute/);
  });
});

describe("TerminalGatewaySession protocol v3", () => {
  it("maintains a multi-task inbox with exact list/get/stop controls and detach-only quit", async () => {
    const { server, url } = await listen();
    let peer: WebSocket | undefined;
    let authorization: string | undefined;
    const received: Array<Record<string, unknown>> = [];

    server.on("connection", (socket, request) => {
      peer = socket;
      authorization = request.headers.authorization;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        received.push(message);
        if (message.type === "session.start") {
          socket.send(JSON.stringify(readyMessage("live_terminal_test")));
          socket.send(JSON.stringify({ type: "task.snapshot", reason: "initial", tasks: [], truncated: false }));
        } else if (message.type === "session.close") {
          socket.close(1000, "session detached");
        }
      });
    });

    const lines: string[] = [];
    const session = new TerminalGatewaySession({
      url,
      authToken: "terminal-test-secret",
      userLabel: "test-user",
      onLine: (line) => lines.push(line),
    });
    await session.connect();

    expect(authorization).toBe("Bearer terminal-test-secret");
    expect(lines.join("\n")).not.toContain("terminal-test-secret");
    expect(received[0]).toMatchObject({
      type: "session.start",
      protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
      profileId: "terminal",
      userLabel: "test-user",
    });
    expect(session.snapshot).toMatchObject({
      connected: true,
      sessionId: "live_terminal_test",
      provider: "mock",
      model: "mock-live",
      tasks: [],
      activeTaskIds: [],
    });

    session.execute("inspect this repository");
    await waitForMessage(received, "text.input");
    expect(received.at(-1)).toMatchObject({ type: "text.input", id: "terminal_1", text: "inspect this repository" });

    peer?.send(JSON.stringify({ type: "response.started", responseId: "response_1" }));
    peer?.send(JSON.stringify({ type: "transcript.delta", speaker: "assistant", text: "I am checking " }));
    peer?.send(JSON.stringify({ type: "transcript.delta", speaker: "assistant", text: "now.\n[connection] untrusted" }));
    peer?.send(JSON.stringify({ type: "response.completed", responseId: "response_1" }));
    await vi.waitFor(() => expect(lines).toContain("[voice] I am checking now.\n  [connection] untrusted"));

    peer?.send(JSON.stringify(taskAccepted("task_alpha", 1, "Inspect repository")));
    peer?.send(JSON.stringify({
      ...taskAccepted("task_beta", 1, "Run tests"),
      state: "queued",
    }));
    peer?.send(JSON.stringify({
      type: "task.started",
      taskId: "task_alpha",
      sequence: 2,
      occurredAt: 102,
      title: "Inspect repository",
    }));
    peer?.send(JSON.stringify({
      type: "task.progress",
      taskId: "task_alpha",
      sequence: 3,
      occurredAt: 103,
      progress: { message: "Reading source files" },
    }));
    await vi.waitFor(() => expect(session.snapshot.tasks).toHaveLength(2));
    expect(session.snapshot.activeTaskIds).toEqual(expect.arrayContaining(["task_alpha", "task_beta"]));

    session.execute("/tasks");
    const list = await waitForNextMessage(received, "task.list");
    expect(list).toMatchObject({ type: "task.list", id: "terminal_2", limit: 50 });
    peer?.send(JSON.stringify({
      type: "task.snapshot",
      reason: "list",
      requestId: list.id,
      tasks: [runningTask("task_alpha", 3), queuedTask("task_beta", 1)],
      truncated: false,
    }));
    await vi.waitFor(() => expect(lines).toContain("[tasks] 2 task(s):"));

    session.execute("/status task_alpha");
    const status = await waitForNextMessage(received, "task.get");
    expect(status).toMatchObject({ type: "task.get", taskId: "task_alpha" });
    peer?.send(JSON.stringify({
      type: "task.snapshot",
      reason: "get",
      requestId: status.id,
      tasks: [runningTask("task_alpha", 3)],
      truncated: false,
    }));
    await vi.waitFor(() => expect(lines.join("\n")).toContain("[Hermes task_alpha]\n  state: running"));

    session.execute("/result task_alpha");
    const result = await waitForMessageCount(received, "task.get", 2);
    peer?.send(JSON.stringify({
      type: "task.snapshot",
      reason: "get",
      requestId: result.id,
      tasks: [runningTask("task_alpha", 3)],
      truncated: false,
    }));
    await vi.waitFor(() => expect(lines).toContain("[result task_alpha] Task is running; no terminal result is available yet."));

    session.execute("/stop");
    expect(received.filter((message) => message.type === "task.stop")).toHaveLength(0);
    expect(lines).toContain("[input] Usage: /stop <taskId>. Name the exact task; /interrupt only stops provider speech.");

    session.execute("/stop task_beta");
    const stop = await waitForNextMessage(received, "task.stop");
    expect(stop).toMatchObject({ type: "task.stop", taskId: "task_beta" });
    peer?.send(JSON.stringify({
      type: "task.stopping",
      taskId: "task_beta",
      sequence: 2,
      occurredAt: 104,
      requestId: stop.id,
      reason: "Stop requested",
    }));
    peer?.send(JSON.stringify({
      type: "task.cancelled",
      taskId: "task_beta",
      sequence: 3,
      occurredAt: 105,
      reason: "Stopped by user",
    }));
    await vi.waitFor(() => expect(session.snapshot.activeTaskIds).toEqual(["task_alpha"]));

    session.execute("/interrupt");
    await waitForMessage(received, "response.cancel");
    expect(lines).toContain("[voice] Provider response interruption requested. Background tasks keep running.");
    session.execute("/approve always");
    expect(received.some((message) => message.type === "approval.respond")).toBe(false);

    expect(session.execute("/quit").closeRequested).toBe(true);
    await session.close();
    await waitForMessage(received, "session.close");
    expect(received.find((message) => message.type === "session.close")).toMatchObject({ detach: true });
    expect(received.some((message) => message.type === "run.stop")).toBe(false);
    expect(received.filter((message) => message.type === "task.stop")).toHaveLength(1);
  });

  it("renders out-of-order terminal results, fetches retained output, and sanitizes terminal escapes", async () => {
    const { server, url } = await listen();
    let peer: WebSocket | undefined;
    const received: Array<Record<string, unknown>> = [];
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        received.push(message);
        if (message.type === "session.start") {
          socket.send(JSON.stringify(readyMessage("results")));
          socket.send(JSON.stringify({
            type: "task.snapshot",
            reason: "reconnect",
            tasks: [runningTask("task_old", 8)],
            truncated: false,
          }));
        } else if (message.type === "session.close") socket.close(1000, "session detached");
      });
    });

    const lines: string[] = [];
    const session = new TerminalGatewaySession({ url, onLine: (line) => lines.push(line) });
    await session.connect();
    await vi.waitFor(() => expect(session.snapshot.tasks).toHaveLength(1));

    peer?.send(JSON.stringify(taskAccepted("task_one", 1, "One")));
    peer?.send(JSON.stringify(taskAccepted("task_two", 1, "Two")));
    peer?.send(JSON.stringify({
      type: "task.completed",
      taskId: "task_two",
      sequence: 2,
      occurredAt: 220,
      result: { summary: "Second finished", truncated: false },
    }));
    peer?.send(JSON.stringify({
      type: "task.failed",
      taskId: "task_one",
      sequence: 2,
      occurredAt: 221,
      error: { code: "test_failed", message: "Tests failed", recoverable: false },
    }));
    peer?.send(JSON.stringify({
      type: "task.unknown",
      taskId: "task_unknown",
      sequence: 4,
      occurredAt: 222,
      error: { code: "state_unknown", message: "Outcome cannot be proven", recoverable: false },
    }));
    await vi.waitFor(() => expect(session.snapshot.tasks.find((task) => task.taskId === "task_two")?.state).toBe("completed"));
    expect(lines).toContain("[Hermes task_one] Failed: Tests failed");
    expect(lines).toContain("[Hermes task_unknown] Outcome unknown: Outcome cannot be proven");

    session.execute("/result task_two");
    const get = await waitForNextMessage(received, "task.get");
    peer?.send(JSON.stringify({
      type: "task.snapshot",
      reason: "get",
      requestId: get.id,
      tasks: [{
        taskId: "task_two",
        sequence: 2,
        state: "completed",
        title: "Two",
        createdAt: 100,
        updatedAt: 220,
        finishedAt: 220,
        result: { summary: "Second finished", output: "\u001b[2Jfull\nresult", truncated: false },
      }],
      truncated: false,
    }));
    await vi.waitFor(() => expect(lines.join("\n")).toContain("[result task_two]\n  full\n  result"));
    expect(lines.join("\n")).not.toContain("\u001b");

    peer?.send(JSON.stringify({
      type: "task.notification",
      taskId: "task_two",
      sequence: 2,
      occurredAt: 220,
      notification: {
        notificationId: "notification_task_two_2",
        kind: "completed",
        delivery: "when_idle",
        message: "Two completed.",
        createdAt: 220,
        acknowledged: false,
      },
    }));
    peer?.send(JSON.stringify({
      type: "task.notification",
      taskId: "task_two",
      sequence: 2,
      occurredAt: 220,
      notification: {
        notificationId: "notification_task_two_2",
        kind: "completed",
        delivery: "when_idle",
        message: "Two completed.",
        createdAt: 220,
        acknowledged: false,
      },
    }));
    await vi.waitFor(() => expect(lines.filter((line) => line.includes("[notification] Two completed.")).length).toBe(1));
    await session.close();
  });

  it("acknowledges only the exact current unread notification with /ack or /read", async () => {
    const { server, url } = await listen();
    let peer: WebSocket | undefined;
    const received: Array<Record<string, unknown>> = [];
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        received.push(message);
        if (message.type === "session.start") {
          socket.send(JSON.stringify(readyMessage("notification_ack")));
          socket.send(JSON.stringify({ type: "task.snapshot", reason: "initial", tasks: [], truncated: false }));
        } else if (message.type === "session.close") socket.close(1000, "session detached");
      });
    });

    const lines: string[] = [];
    const session = new TerminalGatewaySession({ url, onLine: (line) => lines.push(line) });
    await session.connect();
    peer?.send(JSON.stringify(taskAccepted("task_notice", 1, "Notice task")));
    peer?.send(JSON.stringify({
      type: "task.completed",
      taskId: "task_notice",
      sequence: 2,
      occurredAt: 200,
      result: { summary: "done", truncated: false },
    }));
    peer?.send(JSON.stringify(taskNotification("task_notice", "notification_task_notice_2", 2, false)));
    await vi.waitFor(() => expect(lines).toContain("[notification] Notice task completed. (task_notice)"));

    session.execute("/ack");
    expect(lines).toContain("[input] Usage: /ack <taskId>.");
    expect(received.filter((message) => message.type === "task.notification.ack")).toHaveLength(0);

    session.execute("/read task_notice");
    const acknowledgement = await waitForNextMessage(received, "task.notification.ack");
    expect(acknowledgement).toEqual({
      type: "task.notification.ack",
      id: "terminal_1",
      taskId: "task_notice",
      notificationId: "notification_task_notice_2",
    });
    peer?.send(JSON.stringify({
      ...taskNotification("task_notice", "notification_task_notice_2", 3, true),
      requestId: acknowledgement.id,
    }));
    await vi.waitFor(() => expect(session.snapshot.tasks[0]).toMatchObject({ taskId: "task_notice", sequence: 3 }));

    session.execute("/ack task_notice");
    expect(received.filter((message) => message.type === "task.notification.ack")).toHaveLength(1);
    expect(lines).toContain("[notification] task_notice has no unread notification to acknowledge.");
    session.execute("/status");
    expect(lines.join("\n")).toContain("notifications: 0 unread");
    await session.close();
  });

  it("fails closed instead of overwriting conflicting lifecycle content at one sequence", async () => {
    const { server, url } = await listen();
    let peer: WebSocket | undefined;
    server.on("connection", (socket) => {
      peer = socket;
      socket.once("message", () => {
        socket.send(JSON.stringify(readyMessage("lifecycle_conflict")));
        socket.send(JSON.stringify({ type: "task.snapshot", reason: "initial", tasks: [], truncated: false }));
      });
    });

    const lines: string[] = [];
    const session = new TerminalGatewaySession({ url, onLine: (line) => lines.push(line) });
    await session.connect();
    peer?.send(JSON.stringify(taskAccepted("task_conflict", 1, "Original title")));
    peer?.send(JSON.stringify(taskAccepted("task_conflict", 1, "Original title")));
    await vi.waitFor(() => expect(session.snapshot.tasks[0]).toMatchObject({ title: "Original title", sequence: 1 }));
    expect(lines.filter((line) => line.includes("[Hermes task_conflict] Accepted"))).toHaveLength(1);

    peer?.send(JSON.stringify(taskAccepted("task_conflict", 1, "Conflicting title")));
    await vi.waitFor(() => expect(lines.join("\n")).toContain("conflicting lifecycle content"));
    await session.closed;
    expect(session.snapshot.tasks[0]).toMatchObject({ title: "Original title", sequence: 1 });
  });

  it("fails closed instead of overwriting a conflicting snapshot at one lifecycle sequence", async () => {
    const { server, url } = await listen();
    let peer: WebSocket | undefined;
    const received: Array<Record<string, unknown>> = [];
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        received.push(message);
        if (message.type === "session.start") {
          socket.send(JSON.stringify(readyMessage("snapshot_conflict")));
          socket.send(JSON.stringify({
            type: "task.snapshot",
            reason: "initial",
            tasks: [runningTask("task_snapshot", 2)],
            truncated: false,
          }));
        }
      });
    });

    const lines: string[] = [];
    const session = new TerminalGatewaySession({ url, onLine: (line) => lines.push(line) });
    await session.connect();
    await vi.waitFor(() => expect(session.snapshot.tasks[0]).toMatchObject({ state: "running", sequence: 2 }));
    session.execute("/tasks");
    const list = await waitForNextMessage(received, "task.list");
    peer?.send(JSON.stringify({
      type: "task.snapshot",
      reason: "list",
      requestId: list.id,
      tasks: [{
        taskId: "task_snapshot",
        sequence: 2,
        state: "completed",
        title: "Restored task",
        createdAt: 100,
        updatedAt: 102,
        finishedAt: 102,
        result: { summary: "conflicting result", truncated: false },
      }],
      truncated: false,
    }));
    await vi.waitFor(() => expect(lines.join("\n")).toContain("conflicting task state"));
    await session.closed;
    expect(session.snapshot.tasks[0]).toMatchObject({ state: "running", sequence: 2 });
  });

  it("fails closed when an exact stop response names a different task", async () => {
    const { server, url } = await listen();
    let peer: WebSocket | undefined;
    const received: Array<Record<string, unknown>> = [];
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        received.push(message);
        if (message.type === "session.start") {
          socket.send(JSON.stringify(readyMessage("stop_correlation")));
          socket.send(JSON.stringify({ type: "task.snapshot", reason: "initial", tasks: [], truncated: false }));
        }
      });
    });
    const lines: string[] = [];
    const session = new TerminalGatewaySession({ url, onLine: (line) => lines.push(line) });
    await session.connect();
    session.execute("/stop task_expected");
    const stop = await waitForNextMessage(received, "task.stop");
    peer?.send(JSON.stringify({
      type: "task.stopping",
      taskId: "task_wrong",
      sequence: 2,
      occurredAt: 400,
      requestId: stop.id,
      reason: "wrong task",
    }));
    await vi.waitFor(() => expect(lines.join("\n")).toContain("Gateway stop response did not match the requested task id"));
    await session.closed;
  });

  it("fails closed on a different protocol version", async () => {
    const { server, url } = await listen();
    server.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({ ...readyMessage("wrong_version"), protocolVersion: HERMES_LIVE_PROTOCOL_VERSION + 1 }));
      });
    });
    const lines: string[] = [];
    const session = new TerminalGatewaySession({ url, onLine: (line) => lines.push(line) });
    await expect(session.connect()).rejects.toThrow(/protocol mismatch/);
    expect(session.snapshot.connected).toBe(false);
    expect(lines.join("\n")).toContain("Gateway protocol mismatch");
  });

  it("renders audio-only responses honestly and bounds terminal control characters", async () => {
    expect(sanitizeTerminalText("safe\u001b[2J\u0007 text\u202Espoof")).toBe("safe textspoof");
    expect(sanitizeTerminalText("abcdef", 3)).toBe("abc");

    const { server, url } = await listen();
    let peer: WebSocket | undefined;
    server.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (message.type === "session.start") {
          socket.send(JSON.stringify(readyMessage("audio_only")));
          socket.send(JSON.stringify({ type: "task.snapshot", reason: "initial", tasks: [], truncated: false }));
        } else if (message.type === "session.close") socket.close(1000, "session detached");
      });
    });

    const lines: string[] = [];
    const session = new TerminalGatewaySession({ url, onLine: (line) => lines.push(line) });
    await session.connect();
    peer?.send(JSON.stringify({ type: "response.started" }));
    peer?.send(JSON.stringify({ type: "audio.output", data: "AAA=", mimeType: "audio/pcm;rate=24000" }));
    peer?.send(JSON.stringify({ type: "response.completed" }));
    await vi.waitFor(() =>
      expect(lines).toContain("[voice] Audio response received. Use the Hermes Dashboard or browser demo to hear gateway audio."),
    );
    await session.close();
  });

  it("describes an unexpected disconnect without claiming tasks were cancelled", async () => {
    const { server, url } = await listen();
    let peer: WebSocket | undefined;
    server.on("connection", (socket) => {
      peer = socket;
      socket.once("message", () => {
        socket.send(JSON.stringify(readyMessage("disconnect")));
        socket.send(JSON.stringify({ type: "task.snapshot", reason: "initial", tasks: [], truncated: false }));
      });
    });
    const lines: string[] = [];
    const session = new TerminalGatewaySession({ url, onLine: (line) => lines.push(line) });
    await session.connect();
    peer?.send(JSON.stringify(taskAccepted("task_durable", 1, "Durable task")));
    await vi.waitFor(() => expect(session.snapshot.activeTaskIds).toEqual(["task_durable"]));
    peer?.close(1012, "restart");
    await session.closed;
    expect(lines.join("\n")).toContain("Background tasks are server-owned and may still be running");
    expect(lines.join("\n")).not.toContain("asked to stop");
  });
});

function readyMessage(sessionId: string): Record<string, unknown> {
  return {
    type: "session.ready",
    protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
    sessionId,
    model: "mock-live",
    hermes: {},
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
      maxRetained: 200,
      supports: { list: true, get: true, stop: true, resume: false, notificationAck: true },
    },
  };
}

function taskAccepted(taskId: string, sequence: number, title: string): Record<string, unknown> {
  return { type: "task.accepted", taskId, sequence, occurredAt: 100 + sequence, state: "accepted", title };
}

function runningTask(taskId: string, sequence: number): Record<string, unknown> {
  return {
    taskId,
    sequence,
    state: "running",
    title: taskId === "task_alpha" ? "Inspect repository" : "Restored task",
    createdAt: 100,
    updatedAt: 100 + sequence,
    startedAt: 102,
    progress: { message: "Reading source files" },
  };
}

function queuedTask(taskId: string, sequence: number): Record<string, unknown> {
  return { taskId, sequence, state: "queued", title: "Run tests", createdAt: 100, updatedAt: 101 };
}

function taskNotification(
  taskId: string,
  notificationId: string,
  sequence: number,
  acknowledged: boolean,
): Record<string, unknown> {
  return {
    type: "task.notification",
    taskId,
    sequence,
    occurredAt: sequence * 100,
    notification: {
      notificationId,
      kind: "completed",
      delivery: "when_idle",
      message: "Notice task completed.",
      createdAt: 200,
      acknowledged,
    },
  };
}

async function listen(): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test address.");
  return { server, url: `ws://127.0.0.1:${address.port}/v1/live` };
}

async function waitForMessage(messages: Array<Record<string, unknown>>, type: string): Promise<void> {
  await vi.waitFor(() => expect(messages.some((message) => message.type === type)).toBe(true));
}

async function waitForNextMessage(
  messages: Array<Record<string, unknown>>,
  type: string,
): Promise<Record<string, unknown>> {
  await waitForMessage(messages, type);
  const message = messages.find((entry) => entry.type === type);
  if (!message) throw new Error(`Missing ${type} message.`);
  return message;
}

async function waitForMessageCount(
  messages: Array<Record<string, unknown>>,
  type: string,
  count: number,
): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(messages.filter((message) => message.type === type)).toHaveLength(count));
  const message = messages.filter((entry) => entry.type === type).at(-1);
  if (!message) throw new Error(`Missing ${type} message.`);
  return message;
}
