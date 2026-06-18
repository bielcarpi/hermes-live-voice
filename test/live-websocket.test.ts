import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { MockLiveAdapter } from "../src/gemini/mock.js";
import { HermesClient } from "../src/hermes/client.js";
import type { Logger } from "../src/logger.js";
import type { ApprovalChoice } from "../src/protocol.js";
import { startServer } from "../src/server/http.js";

const openServers: Array<{ close(): Promise<void> }> = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("live gateway WebSocket", () => {
  it("runs the text protocol through the real gateway WebSocket", async () => {
    const hermes = fakeHermes();
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start", profileId: "default", userLabel: "Alice Example" });
    const ready = await waitForMessage(socket, "session.ready");

    expect(ready).toMatchObject({
      type: "session.ready",
      model: "mock-live",
    });
    expect(ready.sessionKey).toBeUndefined();
    expect(ready.hermes.baseUrl).toBeUndefined();

    send(socket, { type: "text.input", text: "What is my status?" });
    const completed = await waitForMessage(socket, "run.completed");

    expect(completed).toMatchObject({ type: "run.completed", runId: "run_ws", output: "Hermes says done." });
    expect(hermes.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "What is my status?",
        sessionKey: "agent:main:hermes-live:profile:default:user:alice-example",
      }),
      expect.any(AbortSignal),
    );
  });

  it("bridges approval responses through the real gateway WebSocket", async () => {
    const approvalSubmitted = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield { event: "approval.request", run_id: "run_ws", approval_id: "approval_1" };
        await approvalSubmitted.promise;
        yield { event: "run.completed", output: "Approved." };
      },
      submitApproval: vi.fn(async () => {
        approvalSubmitted.resolve();
        return { resolved: 1 };
      }),
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Delete the stale build" });
    await waitForMessage(socket, "approval.request");
    const approvalResponded = waitForMessage(socket, "approval.responded");
    const completed = waitForMessage(socket, "run.completed");
    send(socket, { type: "approval.respond", runId: "run_ws", choice: "once" });

    await expect(approvalResponded).resolves.toMatchObject({
      type: "approval.responded",
      runId: "run_ws",
      choice: "once",
      resolved: 1,
    });
    await expect(completed).resolves.toMatchObject({ output: "Approved." });
    expect(hermes.submitApproval).toHaveBeenCalledWith("run_ws", "once", {
      signal: expect.any(AbortSignal),
    });
  });

  it("routes client stop requests to the active Hermes run", async () => {
    const stopped = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        await stopped.promise;
        yield { event: "run.cancelled" };
      },
      stopRun: vi.fn(async () => {
        stopped.resolve();
        return { status: "stopping" };
      }),
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Run something long" });
    const started = await waitForMessage(socket, "run.started");
    send(socket, { type: "run.stop", runId: started.runId, reason: "test" });

    await expect(waitForMessage(socket, "run.stopped")).resolves.toMatchObject({ runId: "run_ws", status: "stopping" });
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", expect.any(AbortSignal));
  });

  it("rejects unauthorized WebSocket upgrades when auth is configured", async () => {
    const server = await startServer({
      config: testConfig({ server: { authToken: "secret-token" } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    await expect(expectUpgradeRejected(toWebSocketUrl(server.url), { origin: server.url })).resolves.toBe(401);
  });

  it("allows browser WebSocket auth through the token query parameter", async () => {
    const server = await startServer({
      config: testConfig({ server: { authToken: "secret-token" } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const url = new URL(toWebSocketUrl(server.url));
    url.searchParams.set("token", "secret-token");
    const socket = new WebSocket(url, { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });

    await expect(waitForMessage(socket, "session.ready")).resolves.toMatchObject({ type: "session.ready" });
  });

  it("rejects disallowed WebSocket origins", async () => {
    const server = await startServer({
      config: testConfig({ server: { allowOrigin: "https://app.example.com" } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    await expect(expectUpgradeRejected(toWebSocketUrl(server.url), { origin: "https://evil.example.com" })).resolves.toBe(403);
  });

  it("rejects malformed and oversized audio frames before forwarding to the provider", async () => {
    const server = await startServer({
      config: testConfig({ server: { maxAudioBytes: 2 } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");

    send(socket, { type: "audio.input", data: "%%%not-base64%%%", mimeType: "audio/pcm;rate=24000" });
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: expect.stringContaining("base64"),
    });

    send(socket, { type: "audio.input", data: Buffer.from([1, 2, 3, 4]).toString("base64"), mimeType: "audio/pcm;rate=24000" });
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: expect.stringContaining("HERMES_LIVE_MAX_AUDIO_BYTES"),
    });
  });

  it("rejects odd-byte PCM frames", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");

    send(socket, { type: "audio.input", data: Buffer.from([1]).toString("base64"), mimeType: "audio/pcm;rate=24000" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: expect.stringContaining("even number"),
    });
  });
});

function fakeHermes(
  options: {
    streamEvents?: () => AsyncGenerator<Record<string, unknown>>;
    stopRun?: ReturnType<typeof vi.fn>;
    submitApproval?: ReturnType<typeof vi.fn>;
  } = {},
): HermesClient & {
  startRun: ReturnType<typeof vi.fn>;
  submitApproval: ReturnType<typeof vi.fn>;
  stopRun: ReturnType<typeof vi.fn>;
} {
  const hermes = {
    baseUrl: "http://127.0.0.1:8642",
    assertRunsSupported: vi.fn(async () => ({
      model: "hermes-agent",
      features: {
        run_submission: true,
        run_events_sse: true,
        run_stop: true,
        run_approval_response: true,
      },
    })),
    startRun: vi.fn(async () => ({ runId: "run_ws", status: "started" })),
    getRun: vi.fn(async () => ({ run_id: "run_ws", status: "running" })),
    streamRunEvents:
      options.streamEvents ??
      (async function* () {
        yield { event: "message.delta", delta: "Hermes says " };
        yield { event: "message.delta", delta: "done." };
        yield { event: "run.completed", output: "Hermes says done." };
      }),
    stopRun: options.stopRun ?? vi.fn(async () => ({ status: "stopping" })),
    submitApproval:
      options.submitApproval ??
      vi.fn(async (_runId: string, choice: ApprovalChoice) => ({
        choice,
        resolved: 1,
      })),
  };
  return hermes as unknown as HermesClient & {
    startRun: ReturnType<typeof vi.fn>;
    submitApproval: ReturnType<typeof vi.fn>;
    stopRun: ReturnType<typeof vi.fn>;
  };
}

function send(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value));
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function waitForMessage(socket: WebSocket, type: string): Promise<any> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 2_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/v1/live";
  return parsed.toString();
}

function testConfig(overrides: { server?: Partial<AppConfig["server"]> } = {}): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      sessionPrefix: "agent:main:hermes-live",
      maxAudioBytes: 2_000_000,
      demoEnabled: true,
      ...overrides.server,
    },
    hermes: { baseUrl: "http://127.0.0.1:8642", model: "hermes-agent" },
    realtime: { provider: "mock", model: "mock-live" },
    gemini: { model: "gemini-live-2.5-flash-native-audio", enterprise: false, location: "us-central1" },
    openai: {
      baseUrl: "wss://api.openai.com/v1/realtime",
      model: "gpt-realtime-2",
      voice: "marin",
      reasoningEffort: "low",
      turnDetection: "disabled",
      inputAudioFormat: "pcm16",
      outputAudioFormat: "pcm16",
    },
  };
}

async function expectUpgradeRejected(url: string | URL, headers: Record<string, string>): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timeout = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error("Timed out waiting for rejected WebSocket upgrade"));
    }, 2_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("unexpected-response", onUnexpectedResponse);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number }) => {
      cleanup();
      resolve(response.statusCode ?? 0);
    };
    const onOpen = () => {
      cleanup();
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("unexpected-response", onUnexpectedResponse);
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function fakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
