import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { MockLiveAdapter } from "../src/adapters/outbound/realtime/mock-live.adapter.js";
import type { Logger } from "../src/logger.js";
import type { ApprovalChoice } from "../src/domain/protocol/client-protocol.js";
import type { HermesRunsPort } from "../src/application/live-gateway/ports/hermes-runs.port.js";
import type {
  LiveModelAdapter,
  LiveModelAudio,
  LiveModelCallbacks,
  LiveModelConnectParams,
  LiveModelEvent,
  LiveModelSession,
  LiveToolCall,
} from "../src/application/live-gateway/ports/realtime-model.port.js";
import { startServer } from "../src/adapters/inbound/http/server.js";

const openServers: Array<{ close(): Promise<void> }> = [];
const openSockets: WebSocket[] = [];
const defaultSessionKey = "agent:main:hermes-live:profile:default:user:voice";

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("live gateway WebSocket", () => {
  it("forwards provider transcript speaker and final metadata", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new TranscriptMetadataAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    const ready = waitForMessage(socket, "session.ready");
    const transcript = waitForMessage(socket, "transcript.delta");
    send(socket, { type: "session.start" });

    await expect(ready).resolves.toMatchObject({ type: "session.ready" });
    await expect(transcript).resolves.toEqual({
      type: "transcript.delta",
      speaker: "user",
      text: "Spoken input",
      final: true,
    });
  });

  it("fails closed when a provider emits an oversized transcript delta", async () => {
    const liveModel = new ManualProviderEventAdapter();
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
    const closed = waitForClose(socket);
    liveModel.emit({ type: "text", text: "x".repeat(20_001) });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "realtime_provider_event_invalid",
      recoverable: false,
      message: "Realtime provider emitted an invalid event.",
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
  });

  it("fails closed when a provider emits an oversized audio frame", async () => {
    const liveModel = new ManualProviderEventAdapter();
    const server = await startServer({
      config: testConfig({ server: { maxAudioBytes: 2 } }),
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
    const closed = waitForClose(socket);
    liveModel.emit({
      type: "audio",
      audio: { data: Buffer.from([1, 2, 3, 4]).toString("base64"), mimeType: "audio/pcm;rate=24000" },
    });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "realtime_provider_event_invalid",
      recoverable: false,
      message: "Realtime provider emitted an invalid event.",
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
  });

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
    send(socket, { type: "session.start", profileId: "other-profile", userLabel: "Alice Example" });
    const ready = await waitForMessage(socket, "session.ready");

    expect(ready).toMatchObject({
      type: "session.ready",
      protocolVersion: 2,
      model: "mock-live",
      realtime: {
        provider: "mock",
        audio: { input: { enabled: false }, output: { enabled: false }, turnDetection: "none" },
      },
    });
    expect(ready.sessionKey).toBeUndefined();
    expect(ready.hermes.baseUrl).toBeUndefined();

    const responseStarted = waitForMessage(socket, "response.started");
    const responseCompleted = waitForMessage(socket, "response.completed");
    const completedMessage = waitForMessage(socket, "run.completed");
    send(socket, { type: "text.input", text: "What is my status?" });
    const completed = await completedMessage;

    expect(completed).toMatchObject({ type: "run.completed", runId: "run_ws", output: "Hermes says done." });
    await expect(responseStarted).resolves.toMatchObject({ type: "response.started" });
    await expect(responseCompleted).resolves.toMatchObject({ type: "response.completed" });
    expect(hermes.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "What is my status?",
        sessionKey: defaultSessionKey,
      }),
      expect.any(AbortSignal),
    );
  });

  it("returns the Hermes tool result immediately after a terminal completion event", async () => {
    const iteratorClosed = deferred<void>();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        try {
          yield { event: "run.completed", output: "Terminal result." };
          await new Promise(() => undefined);
        } finally {
          iteratorClosed.resolve();
        }
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Complete, then leave SSE open" });

    await expect(liveModel.nextToolResponse()).resolves.toMatchObject({
      response: { ok: true, run_id: "run_ws", output: "Terminal result." },
    });
    await iteratorClosed.promise;
  });

  it("does not reflect Hermes run failure details into gateway logs or provider responses", async () => {
    const reflectedSecret = "hermes-secret-reflection";
    const logger = fakeLogger();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield { event: "run.failed", error: reflectedSecret };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger,
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Trigger a failed Hermes run" });

    await expect(liveModel.nextToolResponse()).resolves.toMatchObject({
      response: {
        ok: false,
        status: "failed",
        error: "Hermes run failed. Check the gateway logs for details.",
      },
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(reflectedSecret);
    expect(logger.warn).toHaveBeenCalledWith(
      "Hermes run reported failure",
      expect.objectContaining({ error: "hermes_run_failed" }),
    );
  });

  it("orders run.started before a provider terminal event emitted during Hermes startup", async () => {
    const startCalled = deferred<void>();
    const startResult = deferred<{ runId: string; status: string }>();
    const finishRun = deferred<void>();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      startRun: vi.fn(async () => {
        startCalled.resolve();
        return await startResult.promise;
      }),
      streamEvents: async function* () {
        await finishRun.promise;
        yield { event: "run.completed", output: "Finished." };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    send(socket, { type: "text.input", text: "Start slowly" });
    await startCalled.promise;
    liveModel.emitToolCall({
      id: "parallel_start",
      name: "start_hermes_run",
      args: { message: "Do not start twice" },
    });
    await expect(liveModel.nextToolResponse()).resolves.toMatchObject({
      call: { id: "parallel_start" },
      response: { ok: false, error: "A Hermes run is already active for this voice session." },
    });
    expect(hermes.startRun).toHaveBeenCalledTimes(1);
    liveModel.emitEvent({ type: "response", status: "completed", responseId: "provider_tool_turn" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observed.some((message) => message.type === "response.completed")).toBe(false);

    const runStarted = waitForMessage(socket, "run.started");
    const responseCompleted = waitForMessage(socket, "response.completed");
    startResult.resolve({ runId: "run_ws", status: "started" });
    await runStarted;
    await responseCompleted;
    const runStartedIndex = observed.findIndex((message) => message.type === "run.started");
    const responseCompletedIndex = observed.findIndex((message) => message.type === "response.completed");
    expect(runStartedIndex).toBeGreaterThanOrEqual(0);
    expect(responseCompletedIndex).toBeGreaterThan(runStartedIndex);
    finishRun.resolve();
    await liveModel.nextToolResponse();
  });

  it("uses client-selected Hermes identity only when explicitly trusted", async () => {
    const hermes = fakeHermes();
    const server = await startServer({
      config: testConfig({ server: { trustClientIdentity: true } }),
      hermes,
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start", profileId: "Private Profile", userLabel: "Alice Example" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "What is my status?" });
    await waitForMessage(socket, "run.completed");

    expect(hermes.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:hermes-live:profile:private-profile:user:alice-example",
      }),
      expect.any(AbortSignal),
    );
  });

  it("redacts Hermes run event payloads by default", async () => {
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield {
          event: "tool.started",
          run_id: "run_ws",
          timestamp: 1710000000,
          tool: "terminal",
          args: { command: "print-secret" },
        };
        yield { event: "run.completed", output: "Finished." };
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
    const completed = waitForMessage(socket, "run.completed");
    send(socket, { type: "text.input", text: "Run a tool" });
    const runEvent = await waitForMessage(socket, "run.event");

    expect(runEvent.event).toEqual({ event: "tool.started", run_id: "run_ws", timestamp: 1710000000 });
    expect(JSON.stringify(runEvent)).not.toContain("print-secret");
    await completed;
  });

  it("bounds raw Hermes run events before forwarding them to clients", async () => {
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield { event: "tool.started", run_id: "run_ws", args: { output: "x".repeat(300_000) } };
        yield { event: "run.completed", output: "Finished." };
      },
    });
    const server = await startServer({
      config: testConfig({ server: { runEventDetail: "raw" } }),
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
    const completed = waitForMessage(socket, "run.completed");
    send(socket, { type: "text.input", text: "Run a tool" });
    const runEvent = await waitForMessage(socket, "run.event");

    expect(runEvent.event).toMatchObject({
      event: "tool.started",
      run_id: "run_ws",
      truncated: true,
      original_bytes: expect.any(Number),
    });
    expect(JSON.stringify(runEvent)).not.toContain("x".repeat(1_000));
    await completed;
  });

  it("bounds Hermes run output retained and returned by the bridge", async () => {
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield { event: "run.completed", output: "x".repeat(250_000) };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    const completedPromise = waitForMessage(socket, "run.completed");
    send(socket, { type: "text.input", text: "Generate a large result" });

    const completed = await completedPromise;
    const toolResponse = await liveModel.nextToolResponse();
    expect(completed.output).toHaveLength(200_000);
    expect(toolResponse.response.output).toHaveLength(200_000);
  });

  it("reports Hermes startup failures as session start failures", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes({
        assertRunsSupported: vi.fn(async () => {
          throw new Error("Hermes capabilities unavailable");
        }),
      }),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start", id: "req_start_1" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      message: "Hermes API readiness check failed. Check the gateway logs.",
      requestId: "req_start_1",
      recoverable: true,
    });
  });

  it("rejects unsupported client protocol versions before starting a provider session", async () => {
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
    send(socket, { type: "session.start", id: "req_version", protocolVersion: 1 });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "unsupported_protocol_version",
      requestId: "req_version",
      recoverable: false,
      message: expect.stringContaining("use 2"),
    });
  });

  it("echoes request IDs on recoverable client state errors", async () => {
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
    send(socket, { type: "text.input", id: "req_before_start", text: "hello" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_not_started",
      message: "Send session.start before streaming input.",
      requestId: "req_before_start",
      recoverable: true,
    });
  });

  it("echoes request IDs on client schema errors when the raw id is valid", async () => {
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
    send(socket, { type: "text.input", id: "req_empty_text", text: "" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      requestId: "req_empty_text",
    });
  });

  it("reports provider connection failures as session start failures", async () => {
    const logger = fakeLogger();
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new FailingConnectAdapter(
        "Realtime provider did not become ready within 15000ms. reflected provider-startup-secret provider-path-secret provider-query-secret",
      ),
      logger,
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      message: "Realtime provider session failed to start. Check the gateway logs.",
      recoverable: true,
    });
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).toContain("realtime_provider_startup_failed");
    expect(logged).not.toContain("provider-startup-secret");
    expect(logged).not.toContain("provider-path-secret");
    expect(logged).not.toContain("provider-query-secret");
  });

  it("never logs provider-controlled errors after readiness", async () => {
    const liveModel = new ManualProviderEventAdapter();
    const logger = fakeLogger();
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel,
      logger,
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    liveModel.emitError(new Error("reflected provider-error-secret provider-url-secret"));

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "realtime_provider_error",
      message: "Realtime provider reported an error. Check the gateway logs.",
    });
    const responseFailed = waitForMessage(socket, "response.failed");
    liveModel.emit({
      type: "response",
      status: "failed",
      error: "reflected provider-response-secret provider-response-url-secret",
    });
    await expect(responseFailed).resolves.toMatchObject({
      error: "Realtime provider response failed. Check the gateway logs.",
    });
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).toContain("realtime_provider_error");
    expect(logged).toContain("realtime_provider_response_failed");
    expect(logged).not.toContain("provider-error-secret");
    expect(logged).not.toContain("provider-url-secret");
    expect(logged).not.toContain("provider-response-secret");
    expect(logged).not.toContain("provider-response-url-secret");
  });

  it("reports provider errors before readiness as session start failures", async () => {
    const server = await startServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 20 } }),
      hermes: fakeHermes(),
      liveModel: new PreReadyErrorAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    const closed = waitForClose(socket);
    send(socket, { type: "session.start" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      message: "Realtime provider session failed to start. Check the gateway logs.",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
  });

  it("rejects an oversized provider event before readiness without retaining it", async () => {
    const liveModel = new OversizedPreReadyEventAdapter();
    const server = await startServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 1_000 } }),
      hermes: fakeHermes(),
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      message: "Realtime provider exceeded the safe pre-ready event queue limit.",
      recoverable: true,
    });
    await vi.waitFor(() => expect(liveModel.session.close).toHaveBeenCalledTimes(1));
  });

  it("does not send session.ready when a provider opens after a latched startup error", async () => {
    const liveModel = new ErrorThenOpenAdapter();
    const server = await startServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 1_000 } }),
      hermes: fakeHermes(),
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);
    const observed: any[] = [];

    await waitForOpen(socket);
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    send(socket, { type: "session.start" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      message: "Realtime provider session failed to start. Check the gateway logs.",
    });
    await vi.waitFor(() => expect(liveModel.session.close).toHaveBeenCalledTimes(1));
    expect(observed.some((message) => message.type === "session.ready")).toBe(false);
  });

  it("reports provider close before readiness as a session start failure", async () => {
    const server = await startServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 20 } }),
      hermes: fakeHermes(),
      liveModel: new PreReadyCloseAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    const closed = waitForClose(socket);
    send(socket, { type: "session.start" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      message: "Realtime provider session closed before ready.",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
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

  it("reports a session start failure when the provider never becomes ready", async () => {
    const liveModel = new NeverOpenAdapter();
    const server = await startServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 20 } }),
      hermes: fakeHermes(),
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      message: "Realtime provider did not become ready within 20ms.",
      recoverable: true,
    });
    expect(liveModel.session.close).toHaveBeenCalled();

    send(socket, { type: "text.input", text: "after timeout" });
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_not_started",
      recoverable: true,
    });
  });

  it("bounds provider cleanup when a never-ready session ignores close", async () => {
    const liveModel = new NeverOpenHungCloseAdapter();
    const server = await startServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 20 } }),
      hermes: fakeHermes(),
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    const closed = waitForClose(socket);
    send(socket, { type: "session.start", id: "hung_startup_close" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      requestId: "hung_startup_close",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011, reason: "session shutdown unconfirmed" });
    expect(liveModel.session.close).toHaveBeenCalledTimes(1);
  });

  it("waits for a pending provider connection and closes its late session before a clean client close", async () => {
    const liveModel = new PendingConnectAdapter();
    const server = await startServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 1_000 } }),
      hermes: fakeHermes(),
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await liveModel.connectEntered.promise;
    const closed = waitForClose(socket);
    send(socket, { type: "session.close", id: "close_pending_connect" });
    liveModel.releaseConnect.resolve();

    await expect(closed).resolves.toMatchObject({ code: 1000 });
    expect(liveModel.session.close).toHaveBeenCalledTimes(1);
  });

  it("closes abnormally when a pending provider connection misses the cleanup deadline", async () => {
    const liveModel = new PendingConnectAdapter();
    const server = await startServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 20 } }),
      hermes: fakeHermes(),
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await liveModel.connectEntered.promise;
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    send(socket, { type: "session.close", id: "close_stuck_connect" });

    await expect(failed).resolves.toMatchObject({
      code: "session_shutdown_unconfirmed",
      requestId: "close_stuck_connect",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011, reason: "session shutdown unconfirmed" });
    expect(liveModel.session.close).not.toHaveBeenCalled();
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
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_1",
          command: "git push origin feature",
          description: "This command changes a remote repository.",
          pattern_key: "git_push",
          choices: ["once", "session", "always", "deny"],
          allow_permanent: true,
        };
        await approvalSubmitted.promise;
        yield { event: "run.completed", output: "Approved." };
      },
      submitApproval: vi.fn(async (_runId, choice, options) => {
        approvalSubmitted.resolve();
        return confirmedApproval(options, choice);
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
    const runEventPromise = waitForMessage(socket, "run.event");
    const approvalPromise = waitForMessage(socket, "approval.request");
    send(socket, { type: "text.input", text: "Delete the stale build" });
    const runEvent = await runEventPromise;
    const approval = await approvalPromise;
    expect(runEvent).toEqual({
      type: "run.event",
      runId: "run_ws",
      event: { event: "approval.request", run_id: "run_ws" },
    });
    expect(approval.event).toEqual({ event: "approval.request", run_id: "run_ws" });
    expect(approval).toMatchObject({
      approval: {
        command: "git push origin feature",
        description: "This command changes a remote repository.",
        patternKey: "git_push",
        choices: ["once", "session", "always", "deny"],
        allowPermanent: true,
      },
    });
    expect(approval.approval.approvalId).toMatch(/^approval_[a-f0-9]{32}$/);
    expect(approval.approval.approvalId).not.toBe("approval_1");
    const approvalResponded = waitForMessage(socket, "approval.responded");
    const completed = waitForMessage(socket, "run.completed");
    sendApprovalResponse(socket, approval, "once", "approval_response_1");

    await expect(approvalResponded).resolves.toMatchObject({
      type: "approval.responded",
      requestId: "approval_response_1",
      runId: "run_ws",
      approvalId: approval.approval.approvalId,
      choice: "once",
      resolved: 1,
    });
    await expect(completed).resolves.toMatchObject({ output: "Approved." });
    expect(hermes.submitApproval).toHaveBeenCalledWith("run_ws", "once", {
      approvalId: "approval_1",
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
  });

  it.each([
    ["a legacy capability set and no id", false, undefined],
    ["a legacy capability set and an apparent id", false, "legacy_ignored"],
    ["targeted capability without an event id", true, undefined],
  ])("denies and terminates uncorrelated approval runs fail-closed for %s", async (_label, targeted, approvalId) => {
    const submitApproval = vi.fn(async (runId: string, choice: ApprovalChoice) => ({
      run_id: runId,
      choice,
      resolved: 1,
    }));
    const hermes = fakeHermes({
      assertRunsSupported: vi.fn(async () => ({
        model: "hermes-agent",
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
          run_approval_response_by_id: targeted,
        },
      })),
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          ...(approvalId ? { approval_id: approvalId } : {}),
          command: "git push origin main",
          choices: ["once", "deny"],
        };
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      submitApproval,
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
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    send(socket, { type: "text.input", text: "Push safely" });

    await expect(failed).resolves.toMatchObject({
      code: "hermes_approval_identity_unsupported",
      recoverable: false,
      message: expect.stringContaining("the run is being stopped"),
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(observed.filter((message) => message.type === "approval.request")).toHaveLength(0);
    expect(submitApproval).toHaveBeenCalledWith("run_ws", "deny", {
      resolveAll: true,
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
  });

  it("stops even after a confirmed bulk denial because legacy events cannot be correlated", async () => {
    const submitApproval = vi.fn()
      .mockResolvedValueOnce({ run_id: "run_ws", choice: "deny", resolved: 2 });
    const hermes = fakeHermes({
      assertRunsSupported: vi.fn(async () => ({
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
          run_approval_response_by_id: true,
        },
      })),
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        yield { event: "approval.request", run_id: "run_ws", command: "first" };
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      submitApproval,
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
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    send(socket, { type: "text.input", text: "Trigger both" });

    await expect(failed).resolves.toMatchObject({
      code: "hermes_approval_identity_unsupported",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(submitApproval).toHaveBeenCalledTimes(1);
    expect(observed.filter((message) => message.type === "approval.request")).toHaveLength(0);
  });

  it("contains the run when a legacy denial loses a race and Hermes reports no pending approval", async () => {
    const hermes = fakeHermes({
      assertRunsSupported: vi.fn(async () => ({
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
          run_approval_response_by_id: false,
        },
      })),
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        yield { event: "approval.request", run_id: "run_ws", command: "publish release" };
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      submitApproval: vi.fn(async () => {
        throw new Error('Hermes request failed: 409 {"error":{"code":"approval_not_pending"}}');
      }),
      stopRun: vi.fn(async () => ({ run_id: "run_ws", status: "stopping" })),
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
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    send(socket, { type: "text.input", text: "Publish safely" });

    await expect(failed).resolves.toMatchObject({
      code: "hermes_approval_identity_unsupported",
      recoverable: false,
      message: expect.stringContaining("denial could not be confirmed"),
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.submitApproval).toHaveBeenCalledTimes(1);
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
  });

  it("does not process buffered positive or terminal events after uncorrelated approval containment", async () => {
    const pulledAfterBoundary = vi.fn();
    const hermes = fakeHermes({
      assertRunsSupported: vi.fn(async () => ({
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
          run_approval_response_by_id: false,
        },
      })),
      streamEvents: async function* () {
        yield { event: "approval.request", run_id: "run_ws", command: "publish release" };
        pulledAfterBoundary();
        yield { event: "approval.responded", run_id: "run_ws", choice: "once", resolved: 1 };
        yield { event: "run.completed", run_id: "run_ws", output: "must not be processed" };
      },
      submitApproval: vi.fn(async () => ({ run_id: "run_ws", choice: "deny", resolved: 1 })),
      stopRun: vi.fn(async () => ({ run_id: "run_ws", status: "stopping" })),
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
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    send(socket, { type: "text.input", text: "Publish safely" });

    await expect(failed).resolves.toMatchObject({ code: "hermes_approval_identity_unsupported" });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(observed.some((message) => message.type === "run.completed")).toBe(false);
    expect(observed.some(
      (message) => message.type === "run.event" && message.event?.event === "approval.responded",
    )).toBe(false);
    expect(pulledAfterBoundary).not.toHaveBeenCalled();
  });

  it("quarantines pending and in-flight positive approvals before awaiting legacy denial", async () => {
    const targetedSubmitEntered = deferred<void>();
    const releaseTargetedSubmit = deferred<void>();
    const targetedResultReturned = deferred<void>();
    const legacyDenialEntered = deferred<void>();
    const releaseLegacyDenial = deferred<void>();
    const submitApproval = vi.fn(async (
      runId: string,
      choice: ApprovalChoice,
      options?: { approvalId?: string },
    ) => {
      if (options?.approvalId) {
        targetedSubmitEntered.resolve();
        await releaseTargetedSubmit.promise;
        targetedResultReturned.resolve();
        return { run_id: runId, approval_id: options.approvalId, choice, resolved: 1 };
      }
      legacyDenialEntered.resolve();
      await releaseLegacyDenial.promise;
      return { run_id: runId, choice: "deny" as const, resolved: 1 };
    });
    const hermes = fakeHermes({
      assertRunsSupported: vi.fn(async () => ({
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
          run_approval_response_by_id: true,
        },
      })),
      streamEvents: async function* () {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_targeted_before_boundary",
          command: "deploy staging",
          choices: ["once", "deny"],
        };
        await targetedSubmitEntered.promise;
        yield {
          event: "approval.request",
          run_id: "run_ws",
          command: "uncorrelated follow-up",
          choices: ["once", "deny"],
        };
      },
      submitApproval,
      stopRun: vi.fn(async () => ({ run_id: "run_ws", status: "stopping" })),
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
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    const approvalRequest = waitForMessage(socket, "approval.request");
    send(socket, { type: "text.input", text: "Exercise approval quarantine" });
    const approval = await approvalRequest;
    sendApprovalResponse(socket, approval, "once", "approval_before_boundary");
    await targetedSubmitEntered.promise;
    await legacyDenialEntered.promise;

    // The uncorrelated event has crossed the quarantine boundary while the
    // first positive mutation is still in flight. A new response must be
    // rejected locally without another targeted Hermes mutation.
    sendApprovalResponse(socket, approval, "once", "approval_after_boundary");
    await vi.waitFor(() => expect(observed.some(
      (message) => message.type === "session.error" &&
        message.code === "client_message_failed" &&
        message.message.includes("stopping"),
    )).toBe(true));

    releaseTargetedSubmit.resolve();
    await targetedResultReturned.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.some((message) => message.type === "approval.responded")).toBe(false);

    const closed = waitForClose(socket);
    releaseLegacyDenial.resolve();
    await vi.waitFor(() => expect(observed.some(
      (message) => message.type === "session.error" &&
        message.code === "hermes_approval_identity_unsupported",
    )).toBe(true));
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(submitApproval).toHaveBeenCalledTimes(2);
    expect(submitApproval.mock.calls.filter((call) => call[2]?.approvalId)).toHaveLength(1);
    expect(observed.some((message) => message.type === "approval.responded")).toBe(false);
  });

  it("ignores a resolved approval when Hermes redelivers the same source id", async () => {
    const submitted = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        const approval = {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_redelivered",
          command: "deploy staging",
          choices: ["once", "deny"],
        };
        yield approval;
        await submitted.promise;
        yield approval;
        yield { event: "run.completed", output: "Approved once." };
      },
      submitApproval: vi.fn(async (_runId, choice, options) => {
        submitted.resolve();
        return confirmedApproval(options, choice);
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
    const observedAfterFirst: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Deploy once" });
    const approval = await waitForMessage(socket, "approval.request");
    socket.on("message", (raw) => observedAfterFirst.push(JSON.parse(raw.toString("utf8"))));
    const completed = waitForMessage(socket, "run.completed");
    sendApprovalResponse(socket, approval, "once", "approval_redelivery_response");

    await waitForMessage(socket, "approval.responded");
    await completed;
    expect(observedAfterFirst.filter((message) => message.type === "approval.request")).toHaveLength(0);
    expect(hermes.submitApproval).toHaveBeenCalledTimes(1);
  });

  it("rejects approval responses for runs outside the active voice session", async () => {
    const approvalSubmitted = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield { event: "approval.request", run_id: "run_ws", approval_id: "approval_1" };
        await approvalSubmitted.promise;
        yield { event: "run.completed", output: "Approved." };
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
    send(socket, { type: "text.input", text: "Delete the stale build" });
    const opaqueApproval = await waitForMessage(socket, "approval.request");
    expect(opaqueApproval).toMatchObject({
      approval: { choices: ["deny"], allowPermanent: false },
    });
    sendApprovalResponse(socket, { ...opaqueApproval, runId: "other_run" }, "deny", "approval_wrong_run");

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: "Requested Hermes run is not active in this voice session.",
    });
    expect(hermes.submitApproval).not.toHaveBeenCalled();
    approvalSubmitted.resolve();
    await waitForMessage(socket, "run.completed");
  });

  it("does not offer permanent approval without an inspectable permission pattern", async () => {
    const approvalSubmitted = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_1",
          command: "deploy production",
          description: "Deploy the current revision.",
          choices: ["once", "session", "always", "deny"],
          allow_permanent: true,
        };
        await approvalSubmitted.promise;
        yield { event: "run.completed", output: "Approved." };
      },
      submitApproval: vi.fn(async (_runId, choice, options) => {
        approvalSubmitted.resolve();
        return confirmedApproval(options, choice);
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
    send(socket, { type: "text.input", text: "Deploy" });

    const approval = await waitForMessage(socket, "approval.request");
    expect(approval).toMatchObject({
      approval: {
        command: "deploy production",
        choices: ["once", "deny"],
        allowPermanent: false,
      },
    });

    sendApprovalResponse(socket, approval, "deny", "approval_no_pattern");
  });

  it.each([
    [
      "a control-bearing command",
      { command: "deploy\u202e production", description: "Deploy production.", pattern_key: "deploy", choices: ["once", "always", "deny"] },
      ["deny"],
    ],
    [
      "an overlong command",
      { command: "x".repeat(4_001), description: "Run the command.", pattern_key: "command", choices: ["once", "always", "deny"] },
      ["deny"],
    ],
    [
      "a visually blank command",
      { command: "\u0300\u0301", pattern_key: "command", choices: ["once", "always", "deny"] },
      ["deny"],
    ],
    [
      "explicitly empty choices",
      { command: "deploy production", choices: [] },
      ["deny"],
    ],
    [
      "malformed choices",
      { command: "deploy production", choices: ["once", "invalid"] },
      ["deny"],
    ],
    [
      "a transformed permission pattern",
      { command: "deploy production", pattern_key: "deploy\u202ehidden", choices: ["once", "session", "always", "deny"] },
      ["once", "deny"],
    ],
    [
      "more permission patterns than the UI can show",
      { command: "deploy production", pattern_keys: Array.from({ length: 33 }, (_, index) => `deploy_${index}`), choices: ["once", "session", "always", "deny"] },
      ["once", "deny"],
    ],
  ])("never broadens approval from %s", async (_label, approvalEvent, expectedChoices) => {
    const approvalSubmitted = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_projection",
          ...approvalEvent,
        };
        await approvalSubmitted.promise;
        yield { event: "run.completed", output: "Denied safely." };
      },
      submitApproval: vi.fn(async (_runId, choice, options) => {
        approvalSubmitted.resolve();
        return confirmedApproval(options, choice);
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
    send(socket, { type: "text.input", text: "Check approval projection" });
    const approval = await waitForMessage(socket, "approval.request");

    expect(approval.approval.choices).toEqual(expectedChoices);
    expect(approval.approval.allowPermanent).toBe(false);
    expect(approval.approval).not.toHaveProperty("patternKey");
    expect(approval.approval).not.toHaveProperty("patternKeys");

    const completed = waitForMessage(socket, "run.completed");
    sendApprovalResponse(socket, approval, "deny", `deny_projection_${String(_label).replaceAll(" ", "_")}`);
    await waitForMessage(socket, "approval.responded");
    await completed;
  });

  it.each([
    ["control-only", "\u001b[31m\u0000"],
    ["bidi-only", "\u061c\u202e\u2066\u2069"],
    ["combining-mark-only", "\u0300\u0301"],
    ["private-use-only", "\ue000\ue001"],
  ])("does not treat a %s approval pattern as inspectable", async (_label, patternKey) => {
    const approvalSubmitted = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_uninspectable",
          command: "deploy production",
          pattern_key: patternKey,
          choices: ["once", "always"],
          allow_permanent: true,
        };
        await approvalSubmitted.promise;
        yield { event: "run.completed", output: "Denied safely." };
      },
      submitApproval: vi.fn(async (_runId, choice, options) => {
        approvalSubmitted.resolve();
        return confirmedApproval(options, choice);
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
    send(socket, { type: "text.input", text: "Deploy" });

    const approval = await waitForMessage(socket, "approval.request");
    expect(approval.approval).toMatchObject({
      choices: ["once", "deny"],
      allowPermanent: false,
    });
    expect(approval.approval.approvalId).toMatch(/^approval_[a-f0-9]{32}$/);
    expect(approval.approval).not.toHaveProperty("patternKey");

    const responded = waitForMessage(socket, "approval.responded");
    const completed = waitForMessage(socket, "run.completed");
    sendApprovalResponse(socket, approval, "deny", `deny_${_label}`);
    await responded;
    await completed;
  });

  it("correlates and deduplicates approval responses without advancing the FIFO queue", async () => {
    const releaseSecondApproval = deferred<void>();
    const finishRun = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_1",
          command: "deploy staging",
          description: "Deploy the current revision.",
          choices: ["once", "deny"],
        };
        await releaseSecondApproval.promise;
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_2",
          command: "remember deployment approval",
          description: "Allow this action for the current session.",
          pattern_key: "deploy_session",
          choices: ["session", "deny"],
        };
        await finishRun.promise;
        yield { event: "run.completed", output: "Approved in order." };
      },
      submitApproval: vi.fn(async (_runId: string, choice: ApprovalChoice, options) => {
        if (choice === "session") finishRun.resolve();
        return confirmedApproval(options, choice);
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
    send(socket, { type: "text.input", text: "Deploy safely" });

    const first = await waitForMessage(socket, "approval.request");
    expect(first).toMatchObject({
      approval: {
        command: "deploy staging",
        description: "Deploy the current revision.",
        choices: ["once", "deny"],
        allowPermanent: false,
      },
    });
    releaseSecondApproval.resolve();
    const second = await waitForMessage(socket, "approval.request");
    expect(second).toMatchObject({
      approval: { patternKey: "deploy_session", choices: ["session", "deny"] },
    });

    sendApprovalResponse(socket, first, "always", "invalid_always");
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: "Permanent approval requires an inspectable permission pattern.",
    });
    sendApprovalResponse(socket, first, "session", "invalid_session");
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: "Approval choice session was not offered for the pending request.",
    });
    sendApprovalResponse(socket, first, "once", "invalid_bulk", { resolveAll: true });
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: "Bulk approval resolution is not supported; answer each approval in FIFO order.",
    });
    sendApprovalResponse(socket, second, "session", "stale_out_of_order");
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      message: "Approval response does not match the oldest pending request.",
    });
    expect(hermes.submitApproval).not.toHaveBeenCalled();

    const firstResponse = waitForMessage(socket, "approval.responded");
    sendApprovalResponse(socket, first, "once", "approve_first");
    await expect(firstResponse).resolves.toMatchObject({
      requestId: "approve_first",
      approvalId: first.approval.approvalId,
      choice: "once",
      resolved: 1,
    });
    expect(hermes.submitApproval).toHaveBeenCalledTimes(1);

    const duplicateResponse = waitForMessage(socket, "approval.responded");
    sendApprovalResponse(socket, first, "once", "approve_first");
    await expect(duplicateResponse).resolves.toMatchObject({ requestId: "approve_first", resolved: 1 });
    expect(hermes.submitApproval).toHaveBeenCalledTimes(1);

    sendApprovalResponse(socket, first, "once", "stale_first_new_request");
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      message: "Approval response does not match the oldest pending request.",
    });
    expect(hermes.submitApproval).toHaveBeenCalledTimes(1);

    const completed = waitForMessage(socket, "run.completed");
    sendApprovalResponse(socket, second, "session", "approve_second");
    await expect(waitForMessage(socket, "approval.responded")).resolves.toMatchObject({
      requestId: "approve_second",
      approvalId: second.approval.approvalId,
      choice: "session",
      resolved: 1,
    });
    await expect(completed).resolves.toMatchObject({ output: "Approved in order." });

    const postRunDuplicate = waitForMessage(socket, "approval.responded");
    sendApprovalResponse(socket, second, "session", "approve_second");
    await expect(postRunDuplicate).resolves.toMatchObject({
      requestId: "approve_second",
      approvalId: second.approval.approvalId,
      resolved: 1,
    });
    expect(hermes.submitApproval).toHaveBeenCalledTimes(2);

    expect(hermes.submitApproval).toHaveBeenNthCalledWith(1, "run_ws", "once", {
      approvalId: "approval_1",
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
    expect(hermes.submitApproval).toHaveBeenNthCalledWith(2, "run_ws", "session", {
      approvalId: "approval_2",
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
  });

  it("closes when Hermes mutates a reused approval id during submission", async () => {
    const submitEntered = deferred<void>();
    const releaseSubmit = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_reused",
          command: "deploy staging",
          choices: ["once", "deny"],
        };
        await submitEntered.promise;
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_reused",
          command: "deploy production",
          choices: ["once", "deny"],
        };
        await new Promise(() => undefined);
      },
      submitApproval: vi.fn(async (_runId, choice, options) => {
        submitEntered.resolve();
        await releaseSubmit.promise;
        return confirmedApproval(options, choice);
      }),
      stopRun: vi.fn(async () => ({ run_id: "run_ws", status: "stopping" })),
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
    send(socket, { type: "text.input", text: "Deploy safely" });
    const approval = await waitForMessage(socket, "approval.request");
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    sendApprovalResponse(socket, approval, "once", "approval_mutation");

    await submitEntered.promise;
    await expect(failed).resolves.toMatchObject({
      code: "hermes_run_outcome_indeterminate",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    releaseSubmit.resolve();
    expect(hermes.submitApproval).toHaveBeenCalledTimes(1);
  });

  it("stops the run and closes when an approval submission outcome is indeterminate", async () => {
    const streamAborted = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_indeterminate",
          command: "deploy production",
          choices: ["once", "deny"],
        };
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            streamAborted.resolve();
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
        yield { event: "run.completed", output: "unreachable" };
      },
      submitApproval: vi.fn(async () => {
        throw new Error("connection reset after POST");
      }),
      stopRun: vi.fn(async () => ({ run_id: "run_ws", status: "stopping" })),
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
    send(socket, { type: "text.input", text: "Deploy safely" });
    const approval = await waitForMessage(socket, "approval.request");
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    sendApprovalResponse(socket, approval, "deny", "indeterminate_approval");

    await expect(failed).resolves.toMatchObject({
      code: "approval_outcome_indeterminate",
      requestId: "indeterminate_approval",
      recoverable: false,
    });
    await streamAborted.promise;
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.submitApproval).toHaveBeenCalledTimes(1);
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
  });

  it.each([
    ["is not an object", null],
    ["omits the targeted approval identity", { resolved: 1, run_id: "run_ws", choice: "deny" }],
    ["omits the run identity", { resolved: 1, approval_id: "approval_bad_result", choice: "deny" }],
    ["omits the choice", { resolved: 1, run_id: "run_ws", approval_id: "approval_bad_result" }],
    ["contains conflicting run aliases", { resolved: 1, run_id: "run_ws", runId: "run_other", approval_id: "approval_bad_result", choice: "deny" }],
    ["contains conflicting approval aliases", { resolved: 1, run_id: "run_ws", approval_id: "approval_bad_result", approvalId: "approval_other", choice: "deny" }],
    ["names another run", { resolved: 1, run_id: "run_other", approval_id: "approval_bad_result", choice: "deny" }],
    ["echoes another choice", { resolved: 1, run_id: "run_ws", approval_id: "approval_bad_result", choice: "once" }],
    ["does not resolve exactly one request", { resolved: 0, run_id: "run_ws", approval_id: "approval_bad_result", choice: "deny" }],
  ])("fails closed when the approval response %s", async (_label, result) => {
    const streamAborted = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_bad_result",
          command: "deploy production",
          choices: ["once", "deny"],
        };
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            streamAborted.resolve();
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
      submitApproval: vi.fn(async () => result),
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
    send(socket, { type: "text.input", text: "Deploy safely" });
    const approval = await waitForMessage(socket, "approval.request");
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    sendApprovalResponse(socket, approval, "deny", "bad_approval_result");

    await expect(failed).resolves.toMatchObject({
      code: "approval_outcome_indeterminate",
      requestId: "bad_approval_result",
      recoverable: false,
    });
    await streamAborted.promise;
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.submitApproval).toHaveBeenCalledTimes(1);
  });

  it("clears pending approvals as soon as a run stop is accepted", async () => {
    const finishRun = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_stop",
          command: "sleep 30",
          choices: ["once", "deny"],
        };
        await finishRun.promise;
        yield { event: "run.cancelled" };
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
    send(socket, { type: "text.input", text: "Run a long command" });
    const approval = await waitForMessage(socket, "approval.request");

    send(socket, { type: "run.stop", runId: "run_ws", reason: "user cancelled" });
    await expect(waitForMessage(socket, "run.stopping")).resolves.toMatchObject({ runId: "run_ws", status: "stopping" });
    sendApprovalResponse(socket, approval, "once", "approval_after_stop");
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: "The Hermes run is stopping and no longer accepts approval responses.",
    });
    expect(hermes.submitApproval).not.toHaveBeenCalled();

    const terminalStop = waitForMessage(socket, "run.stopped");
    finishRun.resolve();
    await terminalStop;
  });

  it("does not expose or execute provider-originated approval submissions", async () => {
    const finishRun = deferred<void>();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield { event: "approval.request", run_id: "run_ws", approval_id: "approval_provider" };
        await finishRun.promise;
        yield { event: "run.completed", output: "Human decision still required." };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Do something requiring approval" });
    await waitForMessage(socket, "approval.request");

    const response = liveModel.nextToolResponse();
    liveModel.emitToolCall({
      id: "provider_approval",
      name: "submit_hermes_approval",
      args: { run_id: "run_ws", choice: "always", resolve_all: true },
    });
    await expect(response).resolves.toMatchObject({
      call: { id: "provider_approval", name: "submit_hermes_approval" },
      response: { ok: false, error: "Unknown hermes-live tool: submit_hermes_approval" },
    });
    expect(hermes.submitApproval).not.toHaveBeenCalled();

    const completed = waitForMessage(socket, "run.completed");
    finishRun.resolve();
    await completed;
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
        return { run_id: "run_ws", status: "stopping" };
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

    await expect(waitForMessage(socket, "run.stopping")).resolves.toMatchObject({ runId: "run_ws", status: "stopping" });
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
  });

  it("fails closed when Hermes returns conflicting stop response run aliases", async () => {
    const stopRun = vi.fn()
      .mockResolvedValueOnce({ run_id: "run_ws", runId: "run_other", status: "stopping" })
      .mockResolvedValue({ run_id: "run_ws", status: "stopping" });
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      stopRun,
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
    send(socket, { type: "text.input", text: "Run until stopped" });
    const started = await waitForMessage(socket, "run.started");
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    send(socket, { type: "run.stop", runId: started.runId });

    await expect(failed).resolves.toMatchObject({
      code: "hermes_run_outcome_indeterminate",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(stopRun).toHaveBeenCalledTimes(2);
  });

  it("does not emit run.stopping after a terminal event wins the stop race", async () => {
    const stopEntered = deferred<void>();
    const releaseStopResponse = deferred<void>();
    const releaseTerminal = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        await releaseTerminal.promise;
        yield { event: "run.cancelled" };
      },
      stopRun: vi.fn(async () => {
        stopEntered.resolve();
        await releaseStopResponse.promise;
        return { run_id: "run_ws", status: "stopping" };
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
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    send(socket, { type: "text.input", text: "Run something long" });
    const started = await waitForMessage(socket, "run.started");
    send(socket, { type: "run.stop", runId: started.runId, reason: "race test" });
    await stopEntered.promise;

    releaseTerminal.resolve();
    await waitForMessage(socket, "run.stopped");
    releaseStopResponse.resolve();
    await vi.waitFor(() => expect(hermes.stopRun).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(observed.filter((message) => message.type === "run.stopping")).toHaveLength(0);
  });

  it("coalesces concurrent stop controls into one Hermes request and one notification", async () => {
    const releaseRun = deferred<void>();
    const stopEntered = deferred<void>();
    const releaseStop = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        await releaseRun.promise;
        yield { event: "run.cancelled" };
      },
      stopRun: vi.fn(async () => {
        stopEntered.resolve();
        await releaseStop.promise;
        return { run_id: "run_ws", status: "stopping" };
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
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    send(socket, { type: "text.input", text: "Run something long" });
    const started = await waitForMessage(socket, "run.started");
    send(socket, { type: "run.stop", id: "stop_1", runId: started.runId, reason: "first" });
    send(socket, { type: "run.stop", id: "stop_2", runId: started.runId, reason: "second" });
    await stopEntered.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hermes.stopRun).toHaveBeenCalledTimes(1);

    releaseStop.resolve();
    await waitForMessage(socket, "run.stopping");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(observed.filter((message) => message.type === "run.stopping")).toHaveLength(1);
    releaseRun.resolve();
    await waitForMessage(socket, "run.stopped");
  });

  it("contains one indeterminate outcome when concurrent stop controls share a rejection", async () => {
    const stopEntered = deferred<void>();
    const releaseInitialStop = deferred<void>();
    let stopCalls = 0;
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      stopRun: vi.fn(async () => {
        stopCalls += 1;
        if (stopCalls === 1) {
          stopEntered.resolve();
          await releaseInitialStop.promise;
          throw new Error("initial stop transport failed");
        }
        return { run_id: "run_ws", status: "stopping" };
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
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    send(socket, { type: "text.input", text: "Run something long" });
    const started = await waitForMessage(socket, "run.started");
    const closed = waitForClose(socket);
    send(socket, { type: "run.stop", id: "failing_stop_1", runId: started.runId });
    send(socket, { type: "run.stop", id: "failing_stop_2", runId: started.runId });
    await stopEntered.promise;
    releaseInitialStop.resolve();

    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.stopRun).toHaveBeenCalledTimes(2);
    expect(observed.filter(
      (message) => message.type === "session.error" && message.code === "hermes_run_outcome_indeterminate",
    )).toHaveLength(1);
  });

  it("starts the authoritative Hermes stop even when provider cancellation hangs", async () => {
    const releaseRun = deferred<void>();
    const liveModel = new HungCancelToolAdapter();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        await releaseRun.promise;
        yield { event: "run.cancelled" };
      },
      stopRun: vi.fn(async () => ({ run_id: "run_ws", status: "stopping" })),
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Run until stopped" });
    const started = await waitForMessage(socket, "run.started");
    send(socket, { type: "run.stop", runId: started.runId, reason: "stop now" });

    await liveModel.cancelEntered.promise;
    await expect(waitForMessage(socket, "run.stopping")).resolves.toMatchObject({ runId: "run_ws" });
    expect(hermes.stopRun).toHaveBeenCalledTimes(1);
    releaseRun.resolve();
    await waitForMessage(socket, "run.stopped");
  });

  it("rejects approvals and suppresses new approval events after stop intent", async () => {
    const releaseLateApproval = deferred<void>();
    const stopEntered = deferred<void>();
    const releaseStop = deferred<void>();
    const finishRun = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_before_stop",
          command: "deploy staging",
          choices: ["once", "deny"],
        };
        await releaseLateApproval.promise;
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_after_stop",
          command: "deploy production",
          choices: ["once", "deny"],
        };
        await finishRun.promise;
        yield { event: "run.cancelled" };
      },
      stopRun: vi.fn(async () => {
        stopEntered.resolve();
        await releaseStop.promise;
        return { run_id: "run_ws", status: "stopping" };
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
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Deploy carefully" });
    const approval = await waitForMessage(socket, "approval.request");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    send(socket, { type: "run.stop", runId: approval.runId, reason: "changed my mind" });
    try {
      await stopEntered.promise;
      const rejected = waitForMessage(socket, "session.error");
      sendApprovalResponse(socket, approval, "once", "approval_after_stop_intent");
      releaseLateApproval.resolve();

      await expect(rejected).resolves.toMatchObject({
        message: "The Hermes run is stopping and no longer accepts approval responses.",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(observed.filter((message) => message.type === "approval.request")).toHaveLength(0);
      expect(hermes.submitApproval).not.toHaveBeenCalled();
      releaseStop.resolve();
      await waitForMessage(socket, "run.stopping");
      finishRun.resolve();
      await waitForMessage(socket, "run.stopped");
    } finally {
      releaseLateApproval.resolve();
      releaseStop.resolve();
      finishRun.resolve();
    }
  });

  it("rejects client stop requests for runs outside the active voice session", async () => {
    const releaseRun = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        await releaseRun.promise;
        yield { event: "run.completed", output: "Finished." };
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
    send(socket, { type: "text.input", text: "Run something long" });
    await waitForMessage(socket, "run.started");
    send(socket, { type: "run.stop", runId: "other_run", reason: "test" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: "Requested Hermes run is not active in this voice session.",
    });
    expect(hermes.stopRun).not.toHaveBeenCalled();
    releaseRun.resolve();
    await waitForMessage(socket, "run.completed");
  });

  it("rejects provider stop tool calls for runs outside the active voice session", async () => {
    const releaseRun = deferred<void>();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        await releaseRun.promise;
        yield { event: "run.completed", output: "Finished." };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Run something long" });
    await waitForMessage(socket, "run.started");
    liveModel.emitToolCall({ id: "stop_other", name: "stop_hermes_run", args: { run_id: "other_run" } });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "tool_call_failed",
      message: "Requested Hermes run is not active in this voice session.",
      recoverable: true,
    });
    expect(hermes.stopRun).not.toHaveBeenCalled();
    releaseRun.resolve();
    await waitForMessage(socket, "run.completed");
  });

  it("rejects provider tool calls without ids before starting Hermes", async () => {
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes();
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    const closed = waitForClose(socket);
    liveModel.emitToolCall({ name: "start_hermes_run", args: { message: "side effect without call id" } });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "tool_call_failed",
      message: "Realtime provider emitted a tool call without a bounded id.",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.startRun).not.toHaveBeenCalled();
  });

  it("routes provider status tool calls with the Hermes session key", async () => {
    const releaseRun = deferred<void>();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      getRun: vi.fn(async () => ({
        run_id: "run_ws",
        status: "running",
        input: "private user request",
        output: "private run output",
        tool_metadata: { transcript: "x".repeat(300_000) },
      })),
      streamEvents: async function* () {
        await releaseRun.promise;
        yield { event: "run.completed", output: "Finished." };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Run something long" });
    await waitForMessage(socket, "run.started");
    const response = liveModel.nextToolResponse();
    liveModel.emitToolCall({ id: "status_active", name: "get_hermes_run_status", args: { run_id: "run_ws" } });

    const toolResponse = await response;
    expect(toolResponse).toMatchObject({
      call: { id: "status_active", name: "get_hermes_run_status" },
      response: { ok: true, status: { run_id: "run_ws", status: "running" } },
    });
    expect(JSON.stringify(toolResponse)).not.toContain("private");
    expect(hermes.getRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
    releaseRun.resolve();
    await waitForMessage(socket, "run.completed");
  });

  it("rejects a provider status response correlated to another Hermes run", async () => {
    const releaseRun = deferred<void>();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      getRun: vi.fn(async () => ({ run_id: "run_other", runId: "run_ws", status: "running" })),
      streamEvents: async function* () {
        await releaseRun.promise;
        yield { event: "run.completed", output: "Finished." };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Run something long" });
    await waitForMessage(socket, "run.started");
    const response = liveModel.nextToolResponse();
    liveModel.emitToolCall({ id: "status_misrouted", name: "get_hermes_run_status", args: { run_id: "run_ws" } });

    await expect(response).resolves.toMatchObject({
      call: { id: "status_misrouted" },
      response: { ok: false, error: "Hermes run status could not be read. Check the gateway logs." },
    });
    releaseRun.resolve();
    await waitForMessage(socket, "run.completed");
  });

  it("replays exact provider tool-call ids without repeating Hermes side effects", async () => {
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes();
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Run exactly once" });
    await expect(liveModel.nextToolResponse()).resolves.toMatchObject({ response: { ok: true, run_id: "run_ws" } });
    expect(hermes.startRun).toHaveBeenCalledTimes(1);

    liveModel.emitToolCall({
      id: "manual_start",
      name: "start_hermes_run",
      args: { message: "Run exactly once" },
    });
    await expect(liveModel.nextToolResponse()).resolves.toMatchObject({ response: { ok: true, run_id: "run_ws" } });
    expect(hermes.startRun).toHaveBeenCalledTimes(1);
  });

  it("closes on conflicting provider tool-call id reuse", async () => {
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes();
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Original task" });
    await liveModel.nextToolResponse();
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    liveModel.emitToolCall({
      id: "manual_start",
      name: "start_hermes_run",
      args: { message: "Different task" },
    });

    await expect(failed).resolves.toMatchObject({ code: "realtime_tool_call_conflict", recoverable: false });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.startRun).toHaveBeenCalledTimes(1);
  });

  it("stops an owned Hermes run and suppresses its late result when the provider cancels the start tool call", async () => {
    const stopObserved = deferred<void>();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      stopRun: vi.fn(async (runId: string) => {
        stopObserved.resolve();
        return { run_id: runId, status: "stopping" };
      }),
      streamEvents: async function* () {
        await stopObserved.promise;
        yield { event: "run.cancelled", run_id: "run_ws" };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Run until Gemini interrupts" });
    await waitForMessage(socket, "run.started");

    const cancellationLog = waitForMessage(socket, "log");
    const runStopped = waitForMessage(socket, "run.stopped");
    liveModel.emitEvent({ type: "tool_call_cancelled", callIds: ["manual_start"] });

    await expect(cancellationLog).resolves.toMatchObject({
      level: "info",
      message: "Realtime provider cancelled tool call",
    });
    await expect(runStopped).resolves.toMatchObject({ runId: "run_ws", status: "cancelled" });
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(liveModel.toolResponses()).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    liveModel.emitEvent({ type: "tool_call_cancelled", callIds: ["manual_start", "manual_start"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hermes.stopRun).toHaveBeenCalledTimes(1);
    expect(liveModel.toolResponses()).toEqual([]);
  });

  it("fails closed when a completed Hermes start tool call is cancelled too late", async () => {
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes();
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Complete before cancellation arrives" });
    await expect(liveModel.nextToolResponse()).resolves.toMatchObject({
      call: { id: "manual_start" },
      response: { ok: true, run_id: "run_ws" },
    });

    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    liveModel.emitEvent({ type: "tool_call_cancelled", callIds: ["manual_start"] });

    await expect(failed).resolves.toMatchObject({
      code: "hermes_run_tool_cancellation_too_late",
      recoverable: false,
      message: expect.stringContaining("Side effects may already have occurred"),
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.stopRun).not.toHaveBeenCalled();
    expect(liveModel.toolResponses()).toHaveLength(1);
  });

  it("fails closed when cancellation lands in the pending-but-terminal Hermes boundary", async () => {
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        try {
          yield { event: "run.completed", output: "Terminal side effect result." };
        } finally {
          liveModel.emitEvent({ type: "tool_call_cancelled", callIds: ["manual_start"] });
        }
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    send(socket, { type: "text.input", text: "Cancel at the terminal boundary" });

    await expect(failed).resolves.toMatchObject({
      code: "hermes_run_tool_cancellation_too_late",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", expect.any(Object));
    expect(liveModel.toolResponses()).toEqual([]);
  });

  it("fails closed when cancellation overlaps an in-flight provider tool-result send", async () => {
    const liveModel = new StalledToolResponseAdapter();
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
    send(socket, { type: "text.input", text: "Stall the provider result send" });
    await liveModel.sendEntered.promise;

    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    liveModel.emitCancellation();

    await expect(failed).resolves.toMatchObject({
      code: "realtime_tool_cancellation_delivery_indeterminate",
      recoverable: false,
      message: expect.stringContaining("cannot be recalled"),
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(liveModel.session.sendToolResponse).toHaveBeenCalledTimes(1);
    expect(liveModel.session.close).toHaveBeenCalledTimes(1);
  });

  it("skips a provider tool call cancelled while queued behind the concurrency limit", async () => {
    const finishRun = deferred<void>();
    const statusRelease = deferred<void>();
    const threeStatusesEntered = deferred<void>();
    let statusCalls = 0;
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      getRun: vi.fn(async () => {
        statusCalls += 1;
        if (statusCalls === 3) threeStatusesEntered.resolve();
        await statusRelease.promise;
        return { run_id: "run_ws", status: "running" };
      }),
      streamEvents: async function* () {
        await finishRun.promise;
        yield { event: "run.completed", output: "Finished." };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Keep the start operation active" });
    await waitForMessage(socket, "run.started");
    for (const id of ["status_1", "status_2", "status_3"]) {
      liveModel.emitToolCall({ id, name: "get_hermes_run_status", args: { run_id: "run_ws" } });
    }
    await threeStatusesEntered.promise;
    liveModel.emitToolCall({ id: "status_queued", name: "get_hermes_run_status", args: { run_id: "run_ws" } });
    liveModel.emitEvent({ type: "tool_call_cancelled", callIds: ["status_queued"] });

    statusRelease.resolve();
    const statusResponses = await Promise.all([
      liveModel.nextToolResponse(),
      liveModel.nextToolResponse(),
      liveModel.nextToolResponse(),
    ]);
    expect(statusResponses.map(({ call }) => call.id).sort()).toEqual(["status_1", "status_2", "status_3"]);
    expect(hermes.getRun).toHaveBeenCalledTimes(3);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    finishRun.resolve();
    await liveModel.nextToolResponse();
    expect(liveModel.toolResponses().some(({ call }) => call.id === "status_queued")).toBe(false);
  });

  it("fails closed when an acknowledged provider cancellation cannot stop its owned Hermes run", async () => {
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      stopRun: vi.fn(async () => {
        throw new Error("Hermes stop unavailable");
      }),
      streamEvents: async function* (_runId, options) {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Start work whose stop will fail" });
    await waitForMessage(socket, "run.started");

    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    liveModel.emitEvent({ type: "tool_call_cancelled", callIds: ["manual_start"] });

    await expect(failed).resolves.toMatchObject({
      code: "hermes_run_outcome_indeterminate",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.stopRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(liveModel.toolResponses()).toEqual([]);
  });

  it("fails closed when Hermes completes after accepting the provider-cancellation stop request", async () => {
    const stopObserved = deferred<void>();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      stopRun: vi.fn(async (runId: string) => {
        stopObserved.resolve();
        return { run_id: runId, status: "stopping" };
      }),
      streamEvents: async function* () {
        await stopObserved.promise;
        yield { event: "run.completed", run_id: "run_ws", output: "Completed despite stop." };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Race completion against cancellation" });
    await waitForMessage(socket, "run.started");

    const completed = waitForMessage(socket, "run.completed");
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    liveModel.emitEvent({ type: "tool_call_cancelled", callIds: ["manual_start"] });

    await expect(completed).resolves.toMatchObject({ runId: "run_ws", output: "Completed despite stop." });
    await expect(failed).resolves.toMatchObject({
      code: "hermes_run_tool_cancellation_too_late",
      recoverable: false,
      message: expect.stringContaining("completed after its provider tool call was cancelled"),
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.stopRun).toHaveBeenCalledTimes(1);
    expect(liveModel.toolResponses()).toEqual([]);
  });

  it("fails closed when provider cancellation races an unconfirmed Hermes run start", async () => {
    const startEntered = deferred<void>();
    const startResult = deferred<{ runId: string; status: string }>();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      startRun: vi.fn(async () => {
        startEntered.resolve();
        return await startResult.promise;
      }),
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Start with a delayed acknowledgement" });
    await startEntered.promise;

    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    liveModel.emitEvent({ type: "tool_call_cancelled", callIds: ["manual_start"] });
    await expect(failed).resolves.toMatchObject({
      code: "hermes_run_start_cancellation_indeterminate",
      recoverable: false,
      message: expect.stringContaining("before Hermes confirmed its run id"),
    });

    startResult.resolve({ runId: "run_ws", status: "started" });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
    expect(liveModel.toolResponses()).toEqual([]);
  });

  it("suppresses a cancelled read-only provider tool outcome without closing the voice session", async () => {
    const finishRun = deferred<void>();
    const statusEntered = deferred<void>();
    const statusResult = deferred<Record<string, unknown>>();
    const liveModel = new ManualToolAdapter();
    const hermes = fakeHermes({
      getRun: vi.fn(async () => {
        statusEntered.resolve();
        return await statusResult.promise;
      }),
      streamEvents: async function* () {
        await finishRun.promise;
        yield { event: "run.completed", output: "Finished." };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel,
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Keep one run active" });
    await waitForMessage(socket, "run.started");
    liveModel.emitToolCall({ id: "status_cancelled", name: "get_hermes_run_status", args: { run_id: "run_ws" } });
    await statusEntered.promise;
    liveModel.emitEvent({ type: "tool_call_cancelled", callIds: ["status_cancelled"] });
    statusResult.reject(new Error("late status failure after provider cancellation"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(liveModel.toolResponses()).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    finishRun.resolve();
    await waitForMessage(socket, "run.completed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(liveModel.toolResponses()).toHaveLength(1);
    expect(liveModel.toolResponses()[0]).toMatchObject({ call: { id: "manual_start" } });
  });

  it("fails closed on uncorrelated or malformed provider tool cancellations", async () => {
    for (const callIds of [["unknown_call"], []]) {
      const liveModel = new ManualToolAdapter();
      const hermes = fakeHermes();
      const server = await startServer({
        config: testConfig(),
        hermes,
        liveModel,
        logger: fakeLogger(),
      });
      openServers.push(server);
      const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
      openSockets.push(socket);

      await waitForOpen(socket);
      send(socket, { type: "session.start" });
      await waitForMessage(socket, "session.ready");
      const failed = waitForMessage(socket, "session.error");
      const closed = waitForClose(socket);
      liveModel.emitEvent({ type: "tool_call_cancelled", callIds });

      await expect(failed).resolves.toMatchObject({
        code: callIds.length === 0 ? "realtime_provider_event_invalid" : "realtime_tool_cancellation_unknown",
        recoverable: false,
      });
      await expect(closed).resolves.toMatchObject({ code: 1011 });
      expect(hermes.startRun).not.toHaveBeenCalled();
    }
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
    send(socket, {
      type: "response.cancel",
      reason: "barge-in",
      truncate: { itemId: "item_1", contentIndex: 0, audioEndMs: 480 },
    });

    await expect(waitForMessage(socket, "log")).resolves.toMatchObject({
      level: "info",
      message: "Realtime response cancellation requested",
    });
    expect(liveModel.session.cancelResponse).toHaveBeenCalledWith("barge-in", { itemId: "item_1", contentIndex: 0, audioEndMs: 480 });
  });

  it("forwards provider speech-start events for client interruption handling", async () => {
    const liveModel = new SpeechStartedAdapter();
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

    liveModel.emitSpeechStarted();

    await expect(waitForMessage(socket, "input.speech_started")).resolves.toMatchObject({
      type: "input.speech_started",
      provider: "openai",
      itemId: "item_1",
      audioStartMs: 320,
    });
  });

  it("fails closed when a Hermes event is correlated to another run", async () => {
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield {
          event: "approval.request",
          run_id: "run_other",
          approval_id: "misrouted_approval",
          command: "deploy production",
          choices: ["once", "deny"],
        };
      },
      stopRun: vi.fn(async () => ({ run_id: "run_ws", status: "stopping" })),
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
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    const closed = waitForClose(socket);
    send(socket, { type: "text.input", text: "Run until correlation fails" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "hermes_run_outcome_indeterminate",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(observed.filter((message) => message.type === "approval.request")).toHaveLength(0);
    expect(hermes.stopRun).toHaveBeenCalledTimes(1);
  });

  it.each(["ends early", "throws"])("stops and closes when the Hermes event stream %s", async (mode) => {
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield { event: "message.delta", delta: "partial" };
        if (mode === "throws") throw new Error("SSE connection lost");
      },
      stopRun: vi.fn(async () => ({ run_id: "run_ws", status: "stopping" })),
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
    const started = waitForMessage(socket, "run.started");
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    send(socket, { type: "text.input", text: "Run until the stream breaks" });

    await expect(started).resolves.toMatchObject({ runId: "run_ws" });
    await expect(failed).resolves.toMatchObject({
      code: "hermes_run_outcome_indeterminate",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
  });

  it("fails closed when Hermes does not confirm whether a run-start POST mutated state", async () => {
    const hermes = fakeHermes({
      startRun: vi.fn(async () => {
        throw new Error("connection reset after mutating POST");
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
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    send(socket, { type: "text.input", text: "Start exactly one task" });

    await expect(failed).resolves.toMatchObject({
      code: "hermes_run_start_outcome_indeterminate",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(hermes.startRun).toHaveBeenCalledTimes(1);
    expect(hermes.stopRun).not.toHaveBeenCalled();
  });

  it("stops a Hermes run whose start response arrives while the session is closing", async () => {
    const startCalled = deferred<void>();
    const startResult = deferred<{ runId: string; status: string }>();
    const stopped = deferred<void>();
    const hermes = fakeHermes({
      startRun: vi.fn(async () => {
        startCalled.resolve();
        return await startResult.promise;
      }),
      stopRun: vi.fn(async (runId: string, options?: { signal?: AbortSignal; sessionKey?: string }) => {
        expect(runId).toBe("run_late");
        expect(options?.signal?.aborted).toBe(false);
        expect(options?.sessionKey).toBe(defaultSessionKey);
        stopped.resolve();
        return { run_id: "run_ws", status: "stopping" };
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
    send(socket, { type: "text.input", text: "Start, then disconnect" });
    await startCalled.promise;
    const closing = server.close();
    startResult.resolve({ runId: "run_late", status: "started" });

    await stopped.promise;
    await closing;
    expect(hermes.stopRun).toHaveBeenCalledTimes(1);
    openServers.splice(openServers.indexOf(server), 1);
  });

  it("closes abnormally when a pending Hermes start rejects without yielding a run id", async () => {
    const startCalled = deferred<void>();
    const startResult = deferred<{ runId: string; status: string }>();
    const hermes = fakeHermes({
      startRun: vi.fn(async () => {
        startCalled.resolve();
        return await startResult.promise;
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
    send(socket, { type: "text.input", text: "Start, then close ambiguously" });
    await startCalled.promise;
    const observed: any[] = [];
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    const closed = waitForClose(socket);
    send(socket, { type: "session.close", id: "close_during_start" });
    startResult.reject(new Error("connection reset after mutating POST"));

    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(observed).toContainEqual(expect.objectContaining({
      type: "session.error",
      code: "session_shutdown_unconfirmed",
      recoverable: false,
    }));
    expect(hermes.stopRun).not.toHaveBeenCalled();
  });

  it("closes abnormally when session close interrupts an in-flight approval mutation", async () => {
    const submitEntered = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_close_race",
          command: "deploy production",
          choices: ["once", "deny"],
        };
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      submitApproval: vi.fn(async () => {
        submitEntered.resolve();
        return await new Promise<never>(() => undefined);
      }),
      stopRun: vi.fn(async () => ({ run_id: "run_ws", status: "stopping" })),
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
    send(socket, { type: "text.input", text: "Deploy safely" });
    const approval = await waitForMessage(socket, "approval.request");
    sendApprovalResponse(socket, approval, "deny", "approval_before_close");
    await submitEntered.promise;
    const observed: any[] = [];
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    const closed = waitForClose(socket);
    send(socket, { type: "session.close", id: "close_during_approval" });

    await expect(closed).resolves.toMatchObject({ code: 1011 });
    expect(observed).toContainEqual(expect.objectContaining({
      type: "session.error",
      code: "session_shutdown_unconfirmed",
      requestId: "close_during_approval",
      recoverable: false,
    }));
    expect(hermes.stopRun).toHaveBeenCalledTimes(1);
  });

  it("makes concurrent close calls wait for the same in-flight Hermes stop", async () => {
    const stopEntered = deferred<void>();
    const releaseStop = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
        yield { event: "run.completed", output: "unreachable" };
      },
      stopRun: vi.fn(async () => {
        stopEntered.resolve();
        await releaseStop.promise;
        return { run_id: "run_ws", status: "stopping" };
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
    send(socket, { type: "text.input", text: "Run while closing twice" });
    await waitForMessage(socket, "run.started");
    socket.close(1000, "first close");
    await stopEntered.promise;

    let serverCloseFinished = false;
    const secondClose = server.close().then(() => { serverCloseFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(serverCloseFinished).toBe(false);
    releaseStop.resolve();
    await secondClose;
    expect(hermes.stopRun).toHaveBeenCalledTimes(1);
    openServers.splice(openServers.indexOf(server), 1);
  });

  it("closes the client session when the realtime provider closes unexpectedly", async () => {
    const providerClosed = deferred<void>();
    const logger = fakeLogger();
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new ProviderCloseAdapter(
        providerClosed,
        "reflected provider-close-secret provider-url-query-secret",
      ),
      logger,
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    const closed = waitForClose(socket);
    providerClosed.resolve();

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "realtime_provider_closed",
      recoverable: true,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011 });
    const logged = JSON.stringify(vi.mocked(logger.info).mock.calls);
    expect(logged).toContain("providerCode");
    expect(logged).not.toContain("provider-close-secret");
    expect(logged).not.toContain("provider-url-query-secret");
  });

  it("reports unconfirmed Hermes cleanup when an automatic fatal close cannot stop the owned run", async () => {
    const providerClosed = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      stopRun: vi.fn(async () => {
        throw new Error("Hermes stop endpoint unavailable");
      }),
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new ProviderCloseAdapter(providerClosed),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);
    const observed: any[] = [];

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Start owned work" });
    await waitForMessage(socket, "run.started");
    socket.on("message", (raw) => observed.push(JSON.parse(raw.toString("utf8"))));
    const closed = waitForClose(socket);
    providerClosed.resolve();

    await expect(closed).resolves.toMatchObject({ code: 1011, reason: "session shutdown unconfirmed" });
    expect(observed).toContainEqual(expect.objectContaining({
      type: "session.error",
      code: "session_shutdown_unconfirmed",
      recoverable: false,
    }));
    expect(hermes.stopRun).toHaveBeenCalledTimes(1);
  });

  it("aborts the run event stream before issuing a separately bounded Hermes stop on close", async () => {
    const eventStreamAttached = deferred<void>();
    const stopped = deferred<void>();
    let eventStreamSignal: AbortSignal | undefined;
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal; sessionKey?: string }) {
        expect(options?.sessionKey).toBe(defaultSessionKey);
        const signal = options?.signal;
        eventStreamSignal = signal;
        eventStreamAttached.resolve();
        await stopped.promise;
        yield { event: "run.cancelled" };
      },
      stopRun: vi.fn(async (_runId: string, options?: { signal?: AbortSignal; sessionKey?: string }) => {
        expect(eventStreamSignal?.aborted).toBe(true);
        expect(options?.signal?.aborted).toBe(false);
        expect(options?.signal).not.toBe(eventStreamSignal);
        stopped.resolve();
        return { run_id: "run_ws", status: "stopping" };
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
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
  });

  it("hard-times out close-time Hermes stop even when the port ignores abort", async () => {
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      stopRun: vi.fn(async () => await new Promise<never>(() => undefined)),
    });
    const server = await startServer({
      config: testConfig({ hermes: { timeoutMs: 20 } }),
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
    send(socket, { type: "text.input", text: "Keep running until close" });
    await waitForMessage(socket, "run.started");
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    send(socket, { type: "session.close", id: "close_hung_stop" });

    await expect(failed).resolves.toMatchObject({
      code: "session_shutdown_unconfirmed",
      requestId: "close_hung_stop",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1011, reason: "session shutdown unconfirmed" });
    expect(hermes.stopRun).toHaveBeenCalledTimes(1);
  });

  it("treats a client-close event-stream abort as cancellation instead of a run failure", async () => {
    const streamAborted = deferred<void>();
    const logger = fakeLogger();
    const hermes = fakeHermes({
      streamEvents: async function* (_runId: string, options?: { signal?: AbortSignal }) {
        await new Promise<void>((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            streamAborted.resolve();
            reject(new DOMException("This operation was aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              streamAborted.resolve();
              reject(new DOMException("This operation was aborted", "AbortError"));
            },
            { once: true },
          );
        });
        yield { event: "run.completed", output: "unreachable" };
      },
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new MockLiveAdapter(),
      logger,
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Run until the socket closes" });
    await waitForMessage(socket, "run.started");
    socket.close(1000, "test close");

    await streamAborted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logger.warn).not.toHaveBeenCalledWith("Hermes run bridge failed", expect.anything());
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

  it("rejects WebSocket upgrades above the configured session limit", async () => {
    const server = await startServer({
      config: testConfig({ server: { maxSessions: 1 } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const first = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(first);
    await waitForOpen(first);

    await expect(expectUpgradeRejected(toWebSocketUrl(server.url), { origin: server.url })).resolves.toBe(503);
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

  it("rejects matching attacker Origin and Host headers on the default loopback gateway", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const port = new URL(server.url).port;

    await expect(
      expectUpgradeRejected(toWebSocketUrl(server.url), {
        origin: `http://voice.attacker.example:${port}`,
        host: `voice.attacker.example:${port}`,
      }),
    ).resolves.toBe(403);
    await expect(
      expectUpgradeRejected(toWebSocketUrl(server.url), {
        origin: `http://voice.attacker.example:${port}`,
        host: `127.0.0.1:${port}`,
      }),
    ).resolves.toBe(403);
    await expect(
      expectUpgradeRejected(toWebSocketUrl(server.url), {
        origin: `http://127.0.0.1:${port}`,
        host: `voice.attacker.example:${port}`,
      }),
    ).resolves.toBe(403);
  });

  it.each([
    ["localhost", "localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["localhost", "127.0.0.1"],
    ["127.0.0.1", "localhost"],
    ["[::1]", "[::1]"],
    ["127.0.0.2", "localhost"],
  ])("allows default browser origins between loopback hosts (%s to %s)", async (originHost, requestHost) => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const port = new URL(server.url).port;
    const socket = new WebSocket(toWebSocketUrl(server.url), {
      headers: { origin: `http://${originHost}:${port}`, host: `${requestHost}:${port}` },
    });
    openSockets.push(socket);

    await waitForOpen(socket);
  });

  it.each([
    ["http://localhost", "127.0.0.1:80"],
    ["https://[::1]", "localhost:443"],
    ["https://localhost", "[::1]"],
  ])("normalizes equivalent default ports for loopback browser origins (%s)", async (origin, requestHost) => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin, host: requestHost } });
    openSockets.push(socket);

    await waitForOpen(socket);
  });

  it("requires equivalent Origin and Host ports for the default loopback browser policy", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const port = new URL(server.url).port;

    await expect(
      expectUpgradeRejected(toWebSocketUrl(server.url), {
        origin: `http://localhost:${port}`,
        host: "127.0.0.1:65535",
      }),
    ).resolves.toBe(403);
  });

  it("allows headerless native clients through the default loopback policy", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url));
    openSockets.push(socket);

    await waitForOpen(socket);
  });

  it("accepts an exact configured custom browser origin", async () => {
    const allowOrigin = "https://voice.example.com";
    const server = await startServer({
      config: testConfig({ server: { allowOrigin } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), {
      headers: { origin: allowOrigin, host: "gateway.internal" },
    });
    openSockets.push(socket);

    await waitForOpen(socket);
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

    send(socket, { type: "audio.input", id: "req_bad_audio", data: "%%%not-base64%%%", mimeType: "audio/pcm;rate=24000" });
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: expect.stringContaining("base64"),
      requestId: "req_bad_audio",
    });

    send(socket, {
      type: "audio.input",
      id: "req_big_audio",
      data: Buffer.from([1, 2, 3, 4]).toString("base64"),
      mimeType: "audio/pcm;rate=24000",
    });
    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: expect.stringContaining("HERMES_LIVE_MAX_AUDIO_BYTES"),
      requestId: "req_big_audio",
    });
  });

  it("closes an authenticated client that outruns the bounded inbound queue", async () => {
    const audioEntered = deferred<void>();
    const releaseAudio = deferred<void>();
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new SlowAudioAdapter(audioEntered, releaseAudio.promise),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    const frame = { type: "audio.input", data: Buffer.from([0, 0]).toString("base64"), mimeType: "audio/pcm;rate=24000" };
    send(socket, frame);
    await audioEntered.promise;
    const failed = waitForMessage(socket, "session.error");
    const closed = waitForClose(socket);
    for (let index = 0; index < 300; index += 1) send(socket, frame);

    await expect(failed).resolves.toMatchObject({
      code: "client_input_backpressure",
      recoverable: false,
    });
    await expect(closed).resolves.toMatchObject({ code: 1009, reason: "client input backpressure" });
    releaseAudio.resolve();
  });

  it("closes clients that exceed the invalid-message budget", async () => {
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
    const closed = waitForClose(socket);
    for (let index = 0; index < 16; index += 1) socket.send("{");

    await expect(closed).resolves.toMatchObject({ code: 1008, reason: "too many invalid client messages" });
  });

  it("preempts a stalled audio send with realtime response cancellation", async () => {
    const audioEntered = deferred<void>();
    const releaseAudio = deferred<void>();
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new SlowAudioAdapter(audioEntered, releaseAudio.promise),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, {
      type: "audio.input",
      data: Buffer.from([0, 0]).toString("base64"),
      mimeType: "audio/pcm;rate=24000",
    });
    await audioEntered.promise;
    send(socket, { type: "response.cancel", id: "cancel_while_audio_stalled", reason: "barge-in" });

    await expect(waitForMessage(socket, "log")).resolves.toMatchObject({
      level: "debug",
      message: "No active realtime response to cancel",
    });
    releaseAudio.resolve();
  });

  it("preempts stalled audio to deliver a correlated approval response", async () => {
    const audioEntered = deferred<void>();
    const releaseAudio = deferred<void>();
    const approvalSubmitted = deferred<void>();
    const hermes = fakeHermes({
      streamEvents: async function* () {
        yield {
          event: "approval.request",
          run_id: "run_ws",
          approval_id: "approval_during_audio",
          command: "deploy staging",
          choices: ["once", "deny"],
        };
        await approvalSubmitted.promise;
        yield { event: "run.completed", output: "Approved while audio was stalled." };
      },
      submitApproval: vi.fn(async (_runId, _choice, options) => {
        approvalSubmitted.resolve();
        return { ...confirmedApproval(options, "once"), run_id: "run_ws" };
      }),
    });
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new SlowAudioAdapter(audioEntered, releaseAudio.promise),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "Deploy safely" });
    const approval = await waitForMessage(socket, "approval.request");
    send(socket, {
      type: "audio.input",
      data: Buffer.from([0, 0]).toString("base64"),
      mimeType: "audio/pcm;rate=24000",
    });
    await audioEntered.promise;
    const responded = waitForMessage(socket, "approval.responded");
    const completed = waitForMessage(socket, "run.completed");
    sendApprovalResponse(socket, approval, "once", "approval_preempts_audio");

    await responded;
    await completed;
    expect(hermes.submitApproval).toHaveBeenCalledTimes(1);
    releaseAudio.resolve();
  });

  it("rejects oversized text input before forwarding to the provider", async () => {
    const server = await startServer({
      config: testConfig({ server: { maxTextChars: 4 } }),
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

    send(socket, { type: "text.input", text: "12345" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "client_message_failed",
      message: "Text input exceeds HERMES_LIVE_MAX_TEXT_CHARS.",
    });
  });

  it("closes oversized WebSocket payloads before parsing client messages", async () => {
    const server = await startServer({
      config: testConfig({ server: { maxAudioBytes: 1, maxTextChars: 1 } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    socket.on("error", () => undefined);
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");

    const close = waitForClose(socket);
    send(socket, { type: "text.input", text: "x".repeat(6_000) });

    await expect(close).resolves.toMatchObject({ code: 1009 });
  });

  it("rejects oversized provider tool-call text before starting Hermes", async () => {
    const hermes = fakeHermes();
    const server = await startServer({
      config: testConfig({ server: { maxTextChars: 4 } }),
      hermes,
      liveModel: new OversizedToolCallAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });
    await waitForMessage(socket, "session.ready");
    send(socket, { type: "text.input", text: "ask" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "tool_call_failed",
      message: "Hermes run message exceeds HERMES_LIVE_MAX_TEXT_CHARS.",
      recoverable: true,
    });
    expect(hermes.startRun).not.toHaveBeenCalled();
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
    assertRunsSupported?: ReturnType<typeof vi.fn>;
    startRun?: ReturnType<typeof vi.fn>;
    getRun?: ReturnType<typeof vi.fn>;
    streamEvents?: (
      runId: string,
      options?: { signal?: AbortSignal; sessionKey?: string },
    ) => AsyncGenerator<Record<string, unknown>>;
    stopRun?: ReturnType<typeof vi.fn>;
    submitApproval?: ReturnType<typeof vi.fn>;
  } = {},
): HermesRunsPort & {
  startRun: ReturnType<typeof vi.fn>;
  getRun: ReturnType<typeof vi.fn>;
  submitApproval: ReturnType<typeof vi.fn>;
  stopRun: ReturnType<typeof vi.fn>;
} {
  const hermes = {
    baseUrl: "http://127.0.0.1:8642",
    assertRunsSupported:
      options.assertRunsSupported ??
      vi.fn(async () => ({
        model: "hermes-agent",
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
          run_approval_response_by_id: true,
        },
      })),
    startRun: options.startRun ?? vi.fn(async () => ({ runId: "run_ws", status: "started" })),
    getRun: options.getRun ?? vi.fn(async () => ({ run_id: "run_ws", status: "running" })),
    streamRunEvents:
      options.streamEvents ??
      (async function* () {
        yield { event: "message.delta", delta: "Hermes says " };
        yield { event: "message.delta", delta: "done." };
        yield { event: "run.completed", output: "Hermes says done." };
      }),
    stopRun: options.stopRun ?? vi.fn(async () => ({ run_id: "run_ws", status: "stopping" })),
    submitApproval:
      options.submitApproval ??
      vi.fn(async (
        runId: string,
        choice: ApprovalChoice,
        approvalOptions?: { approvalId?: string },
      ) => ({
        run_id: runId,
        ...(approvalOptions?.approvalId ? { approval_id: approvalOptions.approvalId } : {}),
        choice,
        resolved: 1,
      })),
  };
  return hermes as unknown as HermesRunsPort & {
    startRun: ReturnType<typeof vi.fn>;
    getRun: ReturnType<typeof vi.fn>;
    submitApproval: ReturnType<typeof vi.fn>;
    stopRun: ReturnType<typeof vi.fn>;
  };
}

function send(socket: WebSocket, value: unknown): void {
  const message = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  socket.send(JSON.stringify(
    message?.type === "session.start" && message.protocolVersion === undefined
      ? { ...message, protocolVersion: 2 }
      : value,
  ));
}

function sendApprovalResponse(
  socket: WebSocket,
  request: { runId: string; approval: { approvalId: string } },
  choice: ApprovalChoice,
  id: string,
  extra: Record<string, unknown> = {},
): void {
  send(socket, {
    type: "approval.respond",
    id,
    runId: request.runId,
    approvalId: request.approval.approvalId,
    choice,
    ...extra,
  });
}

function confirmedApproval(
  options: { approvalId?: string } | undefined,
  choice: ApprovalChoice,
): { run_id: "run_ws"; approval_id: string; choice: ApprovalChoice; resolved: 1 } {
  if (!options?.approvalId) {
    throw new Error("Expected a targeted approval id in the test contract.");
  }
  return { run_id: "run_ws", approval_id: options.approvalId, choice, resolved: 1 };
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

async function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket close"));
    }, 2_000);
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      resolve({ code, reason: reason.toString("utf8") });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("close", onClose);
    };
    socket.once("close", onClose);
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

function testConfig(overrides: {
  server?: Partial<AppConfig["server"]>;
  hermes?: Partial<AppConfig["hermes"]>;
} = {}): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      sessionPrefix: "agent:main:hermes-live",
      defaultProfileId: "default",
      defaultUserLabel: "voice",
      trustClientIdentity: false,
      runEventDetail: "summary",
      maxSessions: 8,
      maxAudioBytes: 2_000_000,
      maxTextChars: 20_000,
      providerReadyTimeoutMs: 15_000,
      demoEnabled: true,
      ...overrides.server,
      allowUnauthenticated: overrides.server?.allowUnauthenticated ?? false,
    },
    hermes: {
      baseUrl: "http://127.0.0.1:8642",
      model: "hermes-agent",
      timeoutMs: 30_000,
      streamIdleTimeoutMs: 120_000,
      ...overrides.hermes,
    },
    realtime: { provider: "mock", model: "mock-live" },
    gemini: { model: "gemini-3.1-flash-live-preview", enterprise: false, location: "us-central1" },
    openai: {
      baseUrl: "wss://api.openai.com/v1/realtime",
      model: "gpt-realtime-2.1",
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

class TranscriptMetadataAdapter implements LiveModelAdapter {
  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    queueMicrotask(() => {
      params.callbacks.onOpen?.();
      params.callbacks.onEvent({ type: "text", speaker: "user", text: "Spoken input", final: true });
    });
    return new CloseTrackingSession();
  }
}

class SlowAudioAdapter implements LiveModelAdapter {
  constructor(
    private readonly entered: ReturnType<typeof deferred<void>>,
    private readonly release: Promise<void>,
  ) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    queueMicrotask(() => params.callbacks.onOpen?.());
    return new SlowAudioSession(this.entered, this.release, params.callbacks);
  }
}

class SlowAudioSession implements LiveModelSession {
  constructor(
    private readonly entered: ReturnType<typeof deferred<void>>,
    private readonly release: Promise<void>,
    private readonly callbacks: LiveModelCallbacks,
  ) {}

  async sendRealtimeAudio(_audio: LiveModelAudio): Promise<void> {
    this.entered.resolve();
    await this.release;
  }

  async sendText(text: string): Promise<void> {
    this.callbacks.onEvent({
      type: "tool_call",
      call: { id: "slow_audio_start", name: "start_hermes_run", args: { message: text } },
    });
  }
  async sendAudioStreamEnd(): Promise<void> {}
  async cancelResponse(): Promise<boolean> { return false; }
  async sendToolResponse(_call: LiveToolCall, _response: Record<string, unknown>): Promise<void> {}
  async close(): Promise<void> {}
}

class ManualProviderEventAdapter implements LiveModelAdapter {
  private callbacks?: LiveModelCallbacks;

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    this.callbacks = params.callbacks;
    queueMicrotask(() => params.callbacks.onOpen?.());
    return new CloseTrackingSession();
  }

  emit(event: Parameters<LiveModelCallbacks["onEvent"]>[0]): void {
    this.callbacks?.onEvent(event);
  }

  emitError(error: unknown): void {
    this.callbacks?.onError?.(error);
  }
}

class FailingConnectAdapter implements LiveModelAdapter {
  constructor(private readonly message = "Provider did not connect") {}

  async connect(_params: LiveModelConnectParams): Promise<LiveModelSession> {
    throw new Error(this.message);
  }
}

class PreReadyErrorAdapter implements LiveModelAdapter {
  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    params.callbacks.onError?.(new Error("Provider errored before ready"));
    await new Promise(() => undefined);
    return new CloseTrackingSession();
  }
}

class OversizedPreReadyEventAdapter implements LiveModelAdapter {
  readonly session = new CloseTrackingSession();

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    params.callbacks.onEvent({ type: "text", text: "x".repeat(8 * 1024 * 1024) });
    return this.session;
  }
}

class ErrorThenOpenAdapter implements LiveModelAdapter {
  readonly session = new CloseTrackingSession();

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    params.callbacks.onError?.(new Error("provider startup secret"));
    params.callbacks.onOpen?.();
    return this.session;
  }
}

class PreReadyCloseAdapter implements LiveModelAdapter {
  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    params.callbacks.onClose?.({ code: 1006, reason: "closed before ready" });
    await new Promise(() => undefined);
    return new CloseTrackingSession();
  }
}

class NeverOpenAdapter implements LiveModelAdapter {
  readonly session = new CloseTrackingSession();

  async connect(_params: LiveModelConnectParams): Promise<LiveModelSession> {
    return this.session;
  }
}

class NeverOpenHungCloseAdapter implements LiveModelAdapter {
  readonly session = new HungCloseSession();

  async connect(_params: LiveModelConnectParams): Promise<LiveModelSession> {
    return this.session;
  }
}

class PendingConnectAdapter implements LiveModelAdapter {
  readonly connectEntered = deferred<void>();
  readonly releaseConnect = deferred<void>();
  readonly session = new CloseTrackingSession();

  async connect(_params: LiveModelConnectParams): Promise<LiveModelSession> {
    this.connectEntered.resolve();
    await this.releaseConnect.promise;
    return this.session;
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

class CloseTrackingSession implements LiveModelSession {
  readonly close = vi.fn(async () => undefined);

  async sendRealtimeAudio(_audio: LiveModelAudio): Promise<void> {}

  async sendText(_text: string): Promise<void> {}

  async sendAudioStreamEnd(): Promise<void> {}

  async cancelResponse(): Promise<boolean> {
    return false;
  }

  async sendToolResponse(_call: LiveToolCall, _response: Record<string, unknown>): Promise<void> {}
}

class HungCloseSession extends CloseTrackingSession {
  override readonly close = vi.fn(async () => await new Promise<never>(() => undefined));
}

class OversizedToolCallAdapter implements LiveModelAdapter {
  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    queueMicrotask(() => params.callbacks.onOpen?.());
    return new OversizedToolCallSession(params.callbacks);
  }
}

class OversizedToolCallSession implements LiveModelSession {
  constructor(private readonly callbacks: LiveModelCallbacks) {}

  async sendRealtimeAudio(_audio: LiveModelAudio): Promise<void> {}

  async sendText(_text: string): Promise<void> {
    this.callbacks.onEvent({
      type: "tool_call",
      call: { id: "oversized", name: "start_hermes_run", args: { message: "12345" } },
    });
  }

  async sendAudioStreamEnd(): Promise<void> {}

  async cancelResponse(): Promise<boolean> {
    return false;
  }

  async sendToolResponse(_call: LiveToolCall, _response: Record<string, unknown>): Promise<void> {}

  async close(): Promise<void> {}
}

class ManualToolAdapter implements LiveModelAdapter {
  private callbacks?: LiveModelCallbacks;
  private readonly responses: Array<{ call: LiveToolCall; response: Record<string, unknown> }> = [];
  private readonly recordedResponses: Array<{ call: LiveToolCall; response: Record<string, unknown> }> = [];
  private readonly responseWaiters: Array<(value: { call: LiveToolCall; response: Record<string, unknown> }) => void> = [];

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    this.callbacks = params.callbacks;
    queueMicrotask(() => params.callbacks.onOpen?.());
    return new ManualToolSession(params.callbacks, (call, response) => this.recordToolResponse(call, response));
  }

  emitToolCall(call: LiveToolCall): void {
    this.emitEvent({ type: "tool_call", call });
  }

  emitEvent(event: LiveModelEvent): void {
    this.callbacks?.onEvent(event);
  }

  nextToolResponse(): Promise<{ call: LiveToolCall; response: Record<string, unknown> }> {
    const response = this.responses.shift();
    if (response) {
      return Promise.resolve(response);
    }
    return new Promise((resolve) => this.responseWaiters.push(resolve));
  }

  toolResponses(): ReadonlyArray<{ call: LiveToolCall; response: Record<string, unknown> }> {
    return this.recordedResponses;
  }

  private recordToolResponse(call: LiveToolCall, response: Record<string, unknown>): void {
    this.recordedResponses.push({ call, response });
    const waiter = this.responseWaiters.shift();
    if (waiter) {
      waiter({ call, response });
      return;
    }
    this.responses.push({ call, response });
  }
}

class ManualToolSession implements LiveModelSession {
  constructor(
    private readonly callbacks: LiveModelCallbacks,
    private readonly onToolResponse: (call: LiveToolCall, response: Record<string, unknown>) => void,
  ) {}

  async sendRealtimeAudio(_audio: LiveModelAudio): Promise<void> {}

  async sendText(text: string): Promise<void> {
    this.callbacks.onEvent({
      type: "tool_call",
      call: { id: "manual_start", name: "start_hermes_run", args: { message: text } },
    });
  }

  async sendAudioStreamEnd(): Promise<void> {}

  async cancelResponse(): Promise<boolean> {
    return false;
  }

  async sendToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    this.onToolResponse(call, response);
  }

  async close(): Promise<void> {}
}

class StalledToolResponseAdapter implements LiveModelAdapter {
  private callbacks?: LiveModelCallbacks;
  readonly sendEntered = deferred<void>();
  readonly releaseSend = deferred<void>();
  readonly session = new StalledToolResponseSession(this.sendEntered, this.releaseSend);

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    this.callbacks = params.callbacks;
    this.session.setCallbacks(params.callbacks);
    queueMicrotask(() => params.callbacks.onOpen?.());
    return this.session;
  }

  emitCancellation(): void {
    this.callbacks?.onEvent({ type: "tool_call_cancelled", callIds: ["stalled_delivery_start"] });
  }
}

class StalledToolResponseSession implements LiveModelSession {
  private callbacks?: LiveModelCallbacks;

  constructor(
    private readonly sendEntered: ReturnType<typeof deferred<void>>,
    private readonly releaseSend: ReturnType<typeof deferred<void>>,
  ) {}

  setCallbacks(callbacks: LiveModelCallbacks): void {
    this.callbacks = callbacks;
  }

  async sendRealtimeAudio(_audio: LiveModelAudio): Promise<void> {}

  async sendText(text: string): Promise<void> {
    this.callbacks?.onEvent({
      type: "tool_call",
      call: { id: "stalled_delivery_start", name: "start_hermes_run", args: { message: text } },
    });
  }

  async sendAudioStreamEnd(): Promise<void> {}

  async cancelResponse(): Promise<boolean> {
    return false;
  }

  readonly sendToolResponse = vi.fn(async () => {
    this.sendEntered.resolve();
    await this.releaseSend.promise;
  });

  readonly close = vi.fn(async () => {
    this.releaseSend.resolve();
  });
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

class HungCancelToolAdapter implements LiveModelAdapter {
  readonly cancelEntered = deferred<void>();
  private readonly releaseCancel = deferred<boolean>();

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    queueMicrotask(() => params.callbacks.onOpen?.());
    return new HungCancelToolSession(params.callbacks, this.cancelEntered, this.releaseCancel);
  }
}

class HungCancelToolSession implements LiveModelSession {
  constructor(
    private readonly callbacks: LiveModelCallbacks,
    private readonly cancelEntered: ReturnType<typeof deferred<void>>,
    private readonly releaseCancel: ReturnType<typeof deferred<boolean>>,
  ) {}

  async sendRealtimeAudio(_audio: LiveModelAudio): Promise<void> {}

  async sendText(text: string): Promise<void> {
    this.callbacks.onEvent({
      type: "tool_call",
      call: { id: "hung_cancel_start", name: "start_hermes_run", args: { message: text } },
    });
  }

  async sendAudioStreamEnd(): Promise<void> {}

  async cancelResponse(): Promise<boolean> {
    this.cancelEntered.resolve();
    return await this.releaseCancel.promise;
  }

  async sendToolResponse(_call: LiveToolCall, _response: Record<string, unknown>): Promise<void> {}

  async close(): Promise<void> {
    this.releaseCancel.resolve(false);
  }
}

class SpeechStartedAdapter implements LiveModelAdapter {
  private callbacks?: LiveModelCallbacks;

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    this.callbacks = params.callbacks;
    queueMicrotask(() => params.callbacks.onOpen?.());
    return new CloseTrackingSession();
  }

  emitSpeechStarted(): void {
    this.callbacks?.onEvent({ type: "input_speech_started", provider: "openai", itemId: "item_1", audioStartMs: 320 });
  }
}

class ProviderCloseAdapter implements LiveModelAdapter {
  constructor(
    private readonly providerClosed: ReturnType<typeof deferred<void>>,
    private readonly reason = "provider closed",
  ) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    queueMicrotask(() => params.callbacks.onOpen?.());
    this.providerClosed.promise.then(() => params.callbacks.onClose?.({ code: 1006, reason: this.reason }));
    return new ToolEchoSession(params.callbacks);
  }
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
