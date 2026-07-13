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
      protocolVersion: 1,
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
      message: "Hermes capabilities unavailable",
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
    send(socket, { type: "session.start", id: "req_version", protocolVersion: 2 });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "unsupported_protocol_version",
      requestId: "req_version",
      recoverable: false,
      message: expect.stringContaining("use 1"),
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
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new FailingConnectAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      message: "Provider did not connect",
      recoverable: true,
    });
  });

  it("reports provider errors before readiness as session start failures", async () => {
    const server = await startServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 1_000 } }),
      hermes: fakeHermes(),
      liveModel: new PreReadyErrorAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      message: "Provider errored before ready",
      recoverable: true,
    });
  });

  it("reports provider close before readiness as a session start failure", async () => {
    const server = await startServer({
      config: testConfig({ server: { providerReadyTimeoutMs: 1_000 } }),
      hermes: fakeHermes(),
      liveModel: new PreReadyCloseAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const socket = new WebSocket(toWebSocketUrl(server.url), { headers: { origin: server.url } });
    openSockets.push(socket);

    await waitForOpen(socket);
    send(socket, { type: "session.start" });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "session_start_failed",
      message: "Realtime provider session closed before ready.",
      recoverable: true,
    });
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
        };
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
    const approval = await waitForMessage(socket, "approval.request");
    expect(approval).toMatchObject({
      approval: {
        approvalId: "approval_1",
        command: "git push origin feature",
        description: "This command changes a remote repository.",
        patternKey: "git_push",
        choices: ["once", "session", "always", "deny"],
        allowPermanent: true,
      },
    });
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
      sessionKey: defaultSessionKey,
    });
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
      approval: { approvalId: "approval_1", choices: ["once", "deny"], allowPermanent: false },
    });
    send(socket, { type: "approval.respond", runId: "other_run", choice: "once" });

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
    send(socket, { type: "text.input", text: "Deploy" });

    await expect(waitForMessage(socket, "approval.request")).resolves.toMatchObject({
      approval: {
        command: "deploy production",
        choices: ["once", "session", "deny"],
        allowPermanent: false,
      },
    });

    send(socket, { type: "approval.respond", runId: "run_ws", choice: "deny" });
    approvalSubmitted.resolve();
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
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
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
    liveModel.emitToolCall({ name: "start_hermes_run", args: { message: "side effect without call id" } });

    await expect(waitForMessage(socket, "session.error")).resolves.toMatchObject({
      code: "tool_call_failed",
      message: "Realtime tool call start_hermes_run did not include an id.",
      recoverable: true,
    });
    expect(hermes.startRun).not.toHaveBeenCalled();
  });

  it("routes provider status tool calls with the Hermes session key", async () => {
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
    const response = liveModel.nextToolResponse();
    liveModel.emitToolCall({ id: "status_active", name: "get_hermes_run_status", args: { run_id: "run_ws" } });

    await expect(response).resolves.toMatchObject({
      call: { id: "status_active", name: "get_hermes_run_status" },
      response: { ok: true, status: { run_id: "run_ws", status: "running" } },
    });
    expect(hermes.getRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
    releaseRun.resolve();
    await waitForMessage(socket, "run.completed");
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

  it("closes the client session when the realtime provider closes unexpectedly", async () => {
    const providerClosed = deferred<void>();
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new ProviderCloseAdapter(providerClosed),
      logger: fakeLogger(),
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
  });

  it("requests Hermes stop before aborting the run event stream on socket close", async () => {
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
    expect(hermes.stopRun).toHaveBeenCalledWith("run_ws", {
      signal: expect.any(AbortSignal),
      sessionKey: defaultSessionKey,
    });
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
  return hermes as unknown as HermesRunsPort & {
    startRun: ReturnType<typeof vi.fn>;
    getRun: ReturnType<typeof vi.fn>;
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

function testConfig(overrides: { server?: Partial<AppConfig["server"]> } = {}): AppConfig {
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
    hermes: { baseUrl: "http://127.0.0.1:8642", model: "hermes-agent", timeoutMs: 30_000 },
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

class FailingConnectAdapter implements LiveModelAdapter {
  async connect(_params: LiveModelConnectParams): Promise<LiveModelSession> {
    throw new Error("Provider did not connect");
  }
}

class PreReadyErrorAdapter implements LiveModelAdapter {
  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    params.callbacks.onError?.(new Error("Provider errored before ready"));
    await new Promise(() => undefined);
    return new CloseTrackingSession();
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
  private readonly responseWaiters: Array<(value: { call: LiveToolCall; response: Record<string, unknown> }) => void> = [];

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    this.callbacks = params.callbacks;
    queueMicrotask(() => params.callbacks.onOpen?.());
    return new ManualToolSession(params.callbacks, (call, response) => this.recordToolResponse(call, response));
  }

  emitToolCall(call: LiveToolCall): void {
    this.callbacks?.onEvent({ type: "tool_call", call });
  }

  nextToolResponse(): Promise<{ call: LiveToolCall; response: Record<string, unknown> }> {
    const response = this.responses.shift();
    if (response) {
      return Promise.resolve(response);
    }
    return new Promise((resolve) => this.responseWaiters.push(resolve));
  }

  private recordToolResponse(call: LiveToolCall, response: Record<string, unknown>): void {
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
  constructor(private readonly providerClosed: ReturnType<typeof deferred<void>>) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    queueMicrotask(() => params.callbacks.onOpen?.());
    this.providerClosed.promise.then(() => params.callbacks.onClose?.({ code: 1006, reason: "provider closed" }));
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
