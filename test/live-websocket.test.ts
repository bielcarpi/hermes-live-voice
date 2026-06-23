import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { MockLiveAdapter } from "../src/gemini/mock.js";
import { HermesClient } from "../src/hermes/client.js";
import type { Logger } from "../src/logger.js";
import type { ApprovalChoice, LiveModelAudio, LiveToolCall } from "../src/protocol.js";
import type { LiveModelAdapter, LiveModelCallbacks, LiveModelConnectParams, LiveModelSession } from "../src/realtime/live.js";
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

  it("waits to announce ready until the provider session is assigned", async () => {
    const providerOpened = deferred<void>();
    const releaseProvider = deferred<void>();
    const hermes = fakeHermes();
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new DelayedOpenAdapter(providerOpened, releaseProvider.promise),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await providerOpened.promise;
    await expectNoMessage(socket);

    const ready = waitForMessage(socket, "session.ready");
    const earlyTranscript = waitForMessage(socket, "transcript.delta");
    releaseProvider.resolve();

    await expect(ready).resolves.toMatchObject({ type: "session.ready" });
    await expect(earlyTranscript).resolves.toMatchObject({ text: "Provider connected early." });

    send(socket, { type: "text.input", text: "Now ask Hermes" });
    await expect(waitForMessage(socket, "run.completed")).resolves.toMatchObject({
      output: "Hermes says done.",
    });
    expect(hermes.startRun).toHaveBeenCalledWith(expect.objectContaining({ input: "Now ask Hermes" }), expect.any(AbortSignal));
  });

  it("reconstructs completed output from Hermes message deltas", async () => {
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield { event: "message.delta", delta: "streamed " };
        yield { event: "message.delta", delta: "answer" };
        yield { event: "run.completed" };
      },
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
    send(socket, { type: "text.input", text: "Summarize from deltas" });

    await expect(waitForMessage(socket, "run.completed")).resolves.toMatchObject({
      type: "run.completed",
      runId: "run_ws",
      output: "streamed answer",
    });
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

  it("routes realtime response cancellation to the provider session", async () => {
    const liveModel = new CancelTrackingAdapter();
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "response.cancel", reason: "barge-in" });

    await expect(waitForMessage(socket, "log")).resolves.toMatchObject({
      level: "info",
      message: "Realtime response cancellation requested",
    });
    expect(liveModel.session.cancelResponse).toHaveBeenCalledWith("barge-in");
  });

  it("requests Hermes stop before aborting the run event stream on socket close", async () => {
    const eventStreamAttached = deferred<void>();
    const stopped = deferred<void>();
    let eventStreamSignal: AbortSignal | undefined;
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, signal?: AbortSignal) {
        eventStreamSignal = signal;
        eventStreamAttached.resolve();
        await stopped.promise;
        yield { event: "run.cancelled" };
      },
      stopRun: vi.fn(async () => {
        expect(eventStreamSignal?.aborted).toBe(false);
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
    send(socket, { type: "text.input", text: "Run until the socket closes" });
    await waitForMessage(socket, "run.started");
    await eventStreamAttached.promise;
    socket.close(1000, "test close");

    await stopped.promise;
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws");
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
    streamEvents?: (runId: string, signal?: AbortSignal) => AsyncGenerator<Record<string, unknown>>;
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

async function expectNoMessage(socket: WebSocket, durationMs = 50): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);
    const onMessage = (raw: WebSocket.RawData) => {
      cleanup();
      reject(new Error(`Unexpected WebSocket message: ${raw.toString("utf8")}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.once("message", onMessage);
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
    hermes: { baseUrl: "http://127.0.0.1:8642", model: "hermes-agent", timeoutMs: 30_000 },
    realtime: { provider: "mock", model: "mock-live" },
    gemini: { model: "gemini-3.1-flash-live-preview", enterprise: false, location: "us-central1" },
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

class DelayedOpenAdapter implements LiveModelAdapter {
  constructor(
    private readonly providerOpened: ReturnType<typeof deferred<void>>,
    private readonly releaseProvider: Promise<void>,
  ) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    params.callbacks.onOpen?.();
    params.callbacks.onEvent({ type: "text", text: "Provider connected early." });
    this.providerOpened.resolve();
    await this.releaseProvider;
    return new ToolEchoSession(params.callbacks);
  }
}

class ToolEchoSession implements LiveModelSession {
  constructor(private readonly callbacks: LiveModelCallbacks) {}

  async sendRealtimeAudio(_audio: LiveModelAudio): Promise<void> {}

  async sendText(text: string): Promise<void> {
    this.callbacks.onEvent({
      type: "tool_call",
      call: { id: "delayed_call", name: "start_hermes_run", args: { message: text } },
    });
  }

  async sendAudioStreamEnd(): Promise<void> {}

  async cancelResponse(): Promise<boolean> {
    return false;
  }

  async sendToolResponse(_call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    this.callbacks.onEvent({ type: "text", text: typeof response.output === "string" ? response.output : JSON.stringify(response) });
  }

  async close(): Promise<void> {}
}

class CancelTrackingAdapter implements LiveModelAdapter {
  readonly session = new CancelTrackingSession();

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    queueMicrotask(() => params.callbacks.onOpen?.());
    return this.session;
  }
}

class CancelTrackingSession implements LiveModelSession {
  readonly cancelResponse = vi.fn(async () => true);

  async sendRealtimeAudio(_audio: LiveModelAudio): Promise<void> {}

  async sendText(_text: string): Promise<void> {}

  async sendAudioStreamEnd(): Promise<void> {}

  async sendToolResponse(_call: LiveToolCall, _response: Record<string, unknown>): Promise<void> {}

  async close(): Promise<void> {}
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
