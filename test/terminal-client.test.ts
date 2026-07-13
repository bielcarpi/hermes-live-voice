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

describe("TerminalGatewaySession", () => {
  it("runs a persistent text-control session with separate interrupt, stop, and approval controls", async () => {
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
          socket.send(
            JSON.stringify({
              type: "session.ready",
              protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
              sessionId: "live_terminal_test",
              model: "mock-live",
              hermes: {},
              realtime: {
                provider: "mock",
                model: "mock-live",
                audio: { input: { enabled: false }, output: { enabled: false }, turnDetection: "none" },
              },
            }),
          );
        } else if (message.type === "session.close") {
          socket.close(1000, "session closed");
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
    });

    session.execute("inspect this repository");
    await waitForMessage(received, "text.input");
    expect(received.at(-1)).toMatchObject({ type: "text.input", id: "terminal_1", text: "inspect this repository" });

    peer?.send(JSON.stringify({ type: "response.started", responseId: "response_1" }));
    peer?.send(JSON.stringify({ type: "transcript.delta", speaker: "assistant", text: "I am checking " }));
    peer?.send(JSON.stringify({ type: "transcript.delta", speaker: "assistant", text: "now.\n[connection] untrusted text" }));
    peer?.send(JSON.stringify({ type: "audio.output", data: "AAA=", mimeType: "audio/pcm;rate=24000" }));
    peer?.send(JSON.stringify({ type: "response.completed", responseId: "response_1" }));
    await vi.waitFor(() => expect(lines).toContain("[voice] I am checking now.\n  [connection] untrusted text"));

    peer?.send(JSON.stringify({ type: "run.started", runId: "run_terminal", sessionId: "live_terminal_test" }));
    peer?.send(JSON.stringify({ type: "run.event", runId: "run_terminal", event: { event: "tool.started", tool: "terminal" } }));
    peer?.send(
      JSON.stringify({
        type: "approval.request",
        runId: "run_terminal",
        event: { event: "approval.request" },
        approval: {
          approvalId: "approval_terminal_1",
          command: "npm test",
          description: "Run the test suite",
          patternKey: "terminal:npm-test",
          choices: ["once", "session", "always", "deny"],
          allowPermanent: true,
        },
      }),
    );
    peer?.send(
      JSON.stringify({
        type: "approval.request",
        runId: "run_terminal",
        event: { event: "approval.request", approval_id: "approval_terminal_2" },
        approval: {
          approvalId: "approval_terminal_2",
          command: "npm publish",
          description: "Publish the package",
          patternKey: "terminal:npm-publish",
          choices: ["once", "deny"],
          allowPermanent: false,
        },
      }),
    );
    await vi.waitFor(() => expect(session.snapshot.pendingApproval?.runId).toBe("run_terminal"));
    await vi.waitFor(() => expect(session.snapshot.pendingApprovals).toHaveLength(2));
    expect(lines).toContain("[Hermes] tool.started: terminal");
    expect(lines).toContain("[approval] Command: npm test");
    expect(lines).toContain("[approval] Permission pattern: terminal:npm-test");
    expect(lines).toContain("[approval] Queued #2: Publish the package");

    session.execute("/approve always");
    expect(received.filter((message) => message.type === "approval.respond")).toHaveLength(0);
    expect(lines).toContain("[safety] Permanent approval changes future policy. Repeat /approve always to confirm.");
    session.execute("/approve always");
    await waitForMessage(received, "approval.respond");
    expect(received.find((message) => message.type === "approval.respond")).toMatchObject({
      runId: "run_terminal",
      approvalId: "approval_terminal_1",
      choice: "always",
    });

    peer?.send(JSON.stringify({
      type: "approval.responded",
      requestId: "terminal_approval_1",
      runId: "run_terminal",
      approvalId: "approval_terminal_1",
      choice: "always",
      resolved: 1,
    }));
    await vi.waitFor(() => expect(session.snapshot.pendingApproval?.command).toBe("npm publish"));
    expect(lines).toContain("[approval] Command: npm publish");
    session.execute("/approve deny");
    await waitForMessageCount(received, "approval.respond", 2);
    expect(received.filter((message) => message.type === "approval.respond").at(-1)).toMatchObject({
      runId: "run_terminal",
      approvalId: "approval_terminal_2",
      choice: "deny",
    });
    peer?.send(JSON.stringify({
      type: "approval.responded",
      requestId: "terminal_approval_2",
      runId: "run_terminal",
      approvalId: "approval_terminal_2",
      choice: "deny",
      resolved: 1,
    }));
    await vi.waitFor(() => expect(session.snapshot.pendingApprovals).toEqual([]));
    peer?.send(JSON.stringify({
      type: "approval.request",
      runId: "run_terminal",
      event: { event: "approval.request", approval_id: "approval_terminal_3" },
      approval: {
        approvalId: "approval_terminal_3",
        command: "dangerous command",
        patternKey: "\u001b[31m\u202e",
        choices: ["always", "deny"],
        allowPermanent: true,
      },
    }));
    await vi.waitFor(() => expect(session.snapshot.pendingApproval?.choices).toEqual(["deny"]));
    expect(lines).toContain("[approval] Hermes did not provide an inspectable permission pattern; permanent approval is unavailable.");
    session.execute("/approve deny");
    await waitForMessageCount(received, "approval.respond", 3);
    peer?.send(JSON.stringify({
      type: "approval.responded",
      requestId: "terminal_approval_3",
      runId: "run_terminal",
      approvalId: "approval_terminal_3",
      choice: "deny",
      resolved: 1,
    }));
    await vi.waitFor(() => expect(session.snapshot.pendingApprovals).toEqual([]));
    peer?.send(JSON.stringify({
      type: "approval.request",
      runId: "run_terminal",
      event: { event: "approval.request", approval_id: "approval_terminal_4" },
      approval: {
        approvalId: "approval_terminal_4",
        command: "deploy\nproduction",
        patternKey: "terminal:deploy",
        choices: ["once", "session", "deny"],
        allowPermanent: true,
      },
    }));
    await vi.waitFor(() => expect(session.snapshot.pendingApproval?.choices).toEqual(["deny"]));
    expect(session.snapshot.pendingApproval?.patternKeys).toEqual([]);
    session.execute("/approve once");
    expect(lines).toContain("[approval] once is not allowed for this request. Choose: deny.");
    session.execute("/approve deny");
    await waitForMessageCount(received, "approval.respond", 4);
    peer?.send(JSON.stringify({
      type: "approval.responded",
      requestId: "terminal_approval_4",
      runId: "run_terminal",
      approvalId: "approval_terminal_4",
      choice: "deny",
      resolved: 1,
    }));
    await vi.waitFor(() => expect(session.snapshot.pendingApprovals).toEqual([]));
    session.execute("/interrupt");
    await waitForMessage(received, "response.cancel");
    expect(received.find((message) => message.type === "response.cancel")).toMatchObject({
      reason: "terminal user interrupted provider response",
    });

    expect(session.execute("/quit").closeRequested).toBe(false);
    expect(lines).toContain("[safety] A Hermes task is active. Use /stop first, or /quit --force to disconnect and stop it.");
    session.execute("/stop");
    await waitForMessage(received, "run.stop");
    expect(received.find((message) => message.type === "run.stop")).toMatchObject({ runId: "run_terminal" });

    peer?.send(JSON.stringify({ type: "run.completed", runId: "run_terminal", output: "\u001b[2JTests passed" }));
    await vi.waitFor(() => expect(session.snapshot.activeRunId).toBeUndefined());
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).toContain("Tests passed");
    expect(session.execute("/quit").closeRequested).toBe(true);
    await session.close();
  });

  it("fails closed when the gateway negotiates a different protocol version", async () => {
    const { server, url } = await listen();
    server.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(
          JSON.stringify({
            type: "session.ready",
            protocolVersion: HERMES_LIVE_PROTOCOL_VERSION + 1,
            sessionId: "wrong_version",
            model: "mock-live",
            hermes: {},
            realtime: { provider: "mock", model: "mock-live" },
          }),
        );
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
          socket.send(
            JSON.stringify({
              type: "session.ready",
              protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
              sessionId: "audio_only",
              model: "mock-live",
              hermes: {},
              realtime: { provider: "mock", model: "mock-live" },
            }),
          );
        } else if (message.type === "session.close") {
          socket.close(1000, "session closed");
        }
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
});

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

async function waitForMessageCount(
  messages: Array<Record<string, unknown>>,
  type: string,
  count: number,
): Promise<void> {
  await vi.waitFor(() => expect(messages.filter((message) => message.type === type)).toHaveLength(count));
}
