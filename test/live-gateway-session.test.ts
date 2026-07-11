import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import type { ApprovalChoice } from "../src/domain/protocol/client-protocol.js";
import type { HermesRunEvent } from "../src/domain/protocol/server-protocol.js";
import type {
  ClientConnectionPort,
  ClientInboundFrame,
} from "../src/application/live-gateway/ports/client-connection.port.js";
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
import { LiveGatewaySession } from "../src/application/live-gateway/live-gateway-session.js";
import { AGENT_PROGRESS_PREFIX, HEARTBEAT_TEXT } from "../src/application/live-gateway/run-narrator.js";

// ---------- Fake ClientConnectionPort ----------

class FakeClient implements ClientConnectionPort {
  readonly sent: Array<Record<string, unknown>> = [];
  private messageHandler?: (data: ClientInboundFrame) => void;
  private closeHandler?: () => void;
  private errorHandler?: (error: unknown) => void;
  closed = false;
  closeCode?: number;
  closeReason?: string;

  onMessage(handler: (data: ClientInboundFrame) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  onError(handler: (error: unknown) => void): void {
    this.errorHandler = handler;
  }
  sendText(payload: string): void {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }
  close(code: number, reason: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }

  emit(message: Record<string, unknown>): void {
    this.messageHandler?.(JSON.stringify(message));
  }
  emitClose(): void {
    this.closeHandler?.();
  }
  emitError(error: unknown): void {
    this.errorHandler?.(error);
  }
  find(type: string): Record<string, unknown> | undefined {
    return this.sent.find((m) => m.type === type);
  }
}

// ---------- RecordingNarrationAdapter ----------

type RecordedCall =
  | { kind: "sendNarration"; text: string; at: number; seq: number }
  | { kind: "cancelResponse"; reason?: string; at: number; seq: number }
  | { kind: "sendToolResponse"; response: Record<string, unknown>; at: number; seq: number };

class RecordingNarrationAdapter implements LiveModelAdapter {
  readonly calls: RecordedCall[] = [];
  session?: RecordingNarrationSession;
  callbacks?: LiveModelCallbacks;
  private seq = 0;
  sendNarrationResult: boolean | (() => boolean) = true;

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    this.callbacks = params.callbacks;
    const session = new RecordingNarrationSession(
      () => this.seq++,
      (call) => this.calls.push(call),
      () => this.sendNarrationResult,
    );
    this.session = session;
    // Open synchronously so session.ready fires as soon as start() checks.
    params.callbacks.onOpen?.();
    return session;
  }

  emit(event: LiveModelEvent): void {
    this.callbacks?.onEvent(event);
  }
}

class RecordingNarrationSession implements LiveModelSession {
  constructor(
    private readonly nextSeq: () => number,
    private readonly record: (call: RecordedCall) => void,
    private readonly narrationResult: () => boolean | (() => boolean),
  ) {}

  async sendRealtimeAudio(_audio: LiveModelAudio): Promise<void> {}
  async sendText(_text: string): Promise<void> {}
  async sendAudioStreamEnd(): Promise<void> {}
  async sendNarration(text: string): Promise<boolean> {
    const res = this.narrationResult();
    const ok = typeof res === "function" ? res() : res;
    this.record({ kind: "sendNarration", text, at: Date.now(), seq: this.nextSeq() });
    return ok;
  }
  async cancelResponse(reason?: string): Promise<boolean> {
    this.record({
      kind: "cancelResponse",
      ...(reason !== undefined ? { reason } : {}),
      at: Date.now(),
      seq: this.nextSeq(),
    });
    return true;
  }
  async sendToolResponse(_call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    this.record({ kind: "sendToolResponse", response, at: Date.now(), seq: this.nextSeq() });
  }
  async close(): Promise<void> {}
}

// ---------- Scripted HermesRunsPort ----------

interface ScriptedEvent {
  delayMs: number;
  event: HermesRunEvent;
}

function scriptedHermes(script: ScriptedEvent[], overrides: Partial<HermesRunsPort> = {}): HermesRunsPort {
  return {
    baseUrl: "http://127.0.0.1:8642",
    async health() {
      return {};
    },
    async capabilities() {
      return { model: "hermes-agent" };
    },
    async assertRunsSupported() {
      return { model: "hermes-agent", features: { run_submission: true, run_events_sse: true } };
    },
    async startRun() {
      return { runId: "run_test", status: "started" };
    },
    async getRun() {
      return { run_id: "run_test", status: "running" };
    },
    async stopRun() {
      return { run_id: "run_test", status: "stopping" };
    },
    async submitApproval(_runId: string, choice: ApprovalChoice) {
      return { choice, resolved: 1 };
    },
    async *streamRunEvents(): AsyncGenerator<HermesRunEvent> {
      for (const step of script) {
        if (step.delayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, step.delayMs));
        }
        yield step.event;
      }
    },
    ...overrides,
  };
}

// ---------- Test config + logger ----------

function testConfig(overrides: {
  realtime?: Partial<AppConfig["realtime"]>;
  openai?: Partial<AppConfig["openai"]>;
  narration?: Partial<AppConfig["narration"]>;
} = {}): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      allowUnauthenticated: true,
      sessionPrefix: "agent:main:hermes-live",
      maxAudioBytes: 2_000_000,
      maxTextChars: 20_000,
      providerReadyTimeoutMs: 50,
      demoEnabled: false,
    },
    hermes: { baseUrl: "http://127.0.0.1:8642", model: "hermes-agent", timeoutMs: 30_000 },
    realtime: { provider: "openai", model: "gpt-realtime-2", ...overrides.realtime },
    gemini: { model: "gemini-3.1-flash-live-preview", enterprise: false, location: "us-central1" },
    openai: {
      baseUrl: "wss://api.openai.com/v1/realtime",
      model: "gpt-realtime-2",
      voice: "echo",
      reasoningEffort: "low",
      turnDetection: "disabled",
      inputAudioFormat: "pcm16",
      outputAudioFormat: "pcm16",
      ...overrides.openai,
    },
    local: { baseUrl: "ws://127.0.0.1:8765/v1/realtime", voice: "Aiden" },
    narration: {
      enabled: true,
      graceMs: 6_000,
      minGapMs: 12_000,
      heartbeatIdleMs: 25_000,
      heartbeatMax: 2,
      reasoningMode: "paraphrase",
      audioGapMs: 800,
      ...overrides.narration,
    },
  };
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// Advance timers + flush microtasks to let promise chains settle after each timer.
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

// Boot a session past session.ready, then send text.input to fire start_agent_run.
async function bootWithRun(
  config: AppConfig,
  liveModel: RecordingNarrationAdapter,
  hermes: HermesRunsPort,
  logger: Logger,
): Promise<{ client: FakeClient; session: LiveGatewaySession }> {
  const client = new FakeClient();
  const session = new LiveGatewaySession(client, { config, hermes, liveModel, logger });
  session.bind();
  client.emit({ type: "session.start", profileId: "default", userLabel: "tester" });
  // Let the promise chain in start() settle (all sync-ish since our adapter opens synchronously
  // and providerReadyTimeout is 50ms — we don't need to advance timers for it).
  await flush();
  await flush();
  // Simulate the model deciding to start a run via a tool call (mirrors real openai/local flow).
  liveModel.emit({
    type: "tool_call",
    call: { id: "start_1", name: "start_agent_run", args: { message: "run please" } },
  });
  await flush();
  return { client, session };
}

// ---------- Tests ----------

describe("LiveGatewaySession run narration integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers a narration for a reasoning event after the grace window", async () => {
    const hermes = scriptedHermes([
      { delayMs: 8_000, event: { event: "reasoning.available", text: "still thinking about the file /tmp/foo/bar.txt" } as HermesRunEvent },
      { delayMs: 4_000, event: { event: "run.completed", output: "done" } as HermesRunEvent },
    ]);
    const adapter = new RecordingNarrationAdapter();
    const logger = fakeLogger();
    // local provider avoids PTT/openai raw-message noise.
    const { session } = await bootWithRun(testConfig({ realtime: { provider: "local", model: "hf-realtime-voice" } }), adapter, hermes, logger);

    await advance(8_000); // grace closes at 6s, reasoning arrives at 8s
    await advance(4_000); // run.completed at 12s

    const narrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(narrations).toHaveLength(1);
    const [only] = narrations;
    expect(only?.kind).toBe("sendNarration");
    if (only?.kind === "sendNarration") {
      expect(only.text.startsWith(AGENT_PROGRESS_PREFIX)).toBe(true);
      // Path is redacted; original path segment should not appear verbatim.
      expect(only.text).not.toContain("/tmp/foo/bar.txt");
      expect(only.text).toContain("[path]");
    }

    await session.close();
  });

  it("cancels narration before sending the terminal tool response", async () => {
    const hermes = scriptedHermes([
      { delayMs: 8_000, event: { event: "reasoning.available", text: "planning next step" } as HermesRunEvent },
      { delayMs: 1_000, event: { event: "run.completed", output: "done" } as HermesRunEvent },
    ]);
    const adapter = new RecordingNarrationAdapter();
    const logger = fakeLogger();
    const { session } = await bootWithRun(testConfig({ realtime: { provider: "local", model: "hf-realtime-voice" } }), adapter, hermes, logger);

    await advance(8_000); // reasoning + narration at 8s
    await advance(1_000); // run.completed at 9s

    const narrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);
    const cancel = adapter.calls.find(
      (c) => c.kind === "cancelResponse" && c.reason === "narration_cutoff",
    );
    const toolResponse = adapter.calls.find((c) => c.kind === "sendToolResponse");
    expect(cancel).toBeDefined();
    expect(toolResponse).toBeDefined();
    if (cancel && toolResponse) {
      expect(cancel.seq).toBeLessThan(toolResponse.seq);
    }

    await session.close();
  });

  it("stops narration after session.close()", async () => {
    const hermes = scriptedHermes([
      { delayMs: 8_000, event: { event: "reasoning.available", text: "chugging along" } as HermesRunEvent },
      { delayMs: 30_000, event: { event: "reasoning.available", text: "still busy" } as HermesRunEvent },
      { delayMs: 10_000, event: { event: "run.completed", output: "done" } as HermesRunEvent },
    ]);
    const adapter = new RecordingNarrationAdapter();
    const logger = fakeLogger();
    const { session } = await bootWithRun(testConfig({ realtime: { provider: "local", model: "hf-realtime-voice" } }), adapter, hermes, logger);

    await advance(8_000); // one narration delivers
    const before = adapter.calls.filter((c) => c.kind === "sendNarration").length;
    expect(before).toBeGreaterThanOrEqual(1);

    await session.close();
    await flush();

    // Advance a lot; no new narration calls should appear.
    await advance(60_000);
    const after = adapter.calls.filter((c) => c.kind === "sendNarration").length;
    expect(after).toBe(before);
  });

  it("cancels with user_barge_in when input_speech_started arrives after a delivered narration", async () => {
    const hermes = scriptedHermes([
      { delayMs: 8_000, event: { event: "reasoning.available", text: "thinking" } as HermesRunEvent },
      { delayMs: 60_000, event: { event: "run.completed", output: "done" } as HermesRunEvent },
    ]);
    const adapter = new RecordingNarrationAdapter();
    const logger = fakeLogger();
    // local provider: input_speech_started events are honoured naturally.
    const { session } = await bootWithRun(testConfig({ realtime: { provider: "local", model: "hf-realtime-voice" } }), adapter, hermes, logger);

    await advance(8_000); // narration lands at ~8s
    const narrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);

    // User barges in.
    adapter.emit({ type: "input_speech_started", provider: "local" });
    await flush();

    const bargeCancel = adapter.calls.find(
      (c) => c.kind === "cancelResponse" && c.reason === "user_barge_in",
    );
    expect(bargeCancel).toBeDefined();

    await session.close();
  });

  it("defers narration while userSpeaking is true and delivers after input_speech_stopped", async () => {
    const hermes = scriptedHermes([
      { delayMs: 7_000, event: { event: "reasoning.available", text: "thinking" } as HermesRunEvent },
      { delayMs: 60_000, event: { event: "run.completed", output: "done" } as HermesRunEvent },
    ]);
    const adapter = new RecordingNarrationAdapter();
    const logger = fakeLogger();
    const { session } = await bootWithRun(testConfig({ realtime: { provider: "local", model: "hf-realtime-voice" } }), adapter, hermes, logger);

    // User speaking from t=0.
    adapter.emit({ type: "input_speech_started", provider: "local" });
    await flush();

    // Reasoning arrives at t=7s while userSpeaking = true.
    await advance(7_000);

    // Grace closed at 6s. Attempt would have been made, but deliver() returned false due to userSpeaking gate.
    // So no narration should be recorded yet.
    let narrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(narrations).toHaveLength(0);

    // Stop speaking; poke() runs immediately after speech_stopped.
    adapter.emit({ type: "input_speech_stopped", provider: "local" });
    await flush();
    // Give the tick a moment (immediate — grace has closed, no min-gap since lastSuccessAt is undefined).
    await advance(1);

    narrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);

    await session.close();
  });

  it("never constructs a narrator for gemini provider and logs a warning", async () => {
    const hermes = scriptedHermes([
      { delayMs: 8_000, event: { event: "reasoning.available", text: "thinking" } as HermesRunEvent },
      { delayMs: 4_000, event: { event: "run.completed", output: "done" } as HermesRunEvent },
    ]);
    const adapter = new RecordingNarrationAdapter();
    const logger = fakeLogger();
    const { session } = await bootWithRun(
      testConfig({ realtime: { provider: "gemini", model: "gemini-3.1-flash-live-preview" } }),
      adapter,
      hermes,
      logger,
    );

    await advance(8_000);
    await advance(4_000);

    const narrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(narrations).toHaveLength(0);

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (args) => args[0] === "narration_disabled_for_provider",
    );
    expect(warnCalls).toHaveLength(1);

    await session.close();
  });

  it("PTT fallback: openai+disabled turn-detection suppresses narration while audio is active", async () => {
    const hermes = scriptedHermes([
      { delayMs: 7_000, event: { event: "reasoning.available", text: "thinking" } as HermesRunEvent },
      { delayMs: 30_000, event: { event: "run.completed", output: "done" } as HermesRunEvent },
    ]);
    const adapter = new RecordingNarrationAdapter();
    const logger = fakeLogger();
    // openai + turnDetection "disabled" is the repo default -> PTT fallback active.
    const { client, session } = await bootWithRun(testConfig(), adapter, hermes, logger);

    // Simulate audio.input streaming from t=6s to t=9s. Give a tiny lead-in so the first frame
    // fires before grace closes so the frame is well within the "audio active" window.
    await advance(6_000);
    const pcmBase64 = Buffer.from(new Uint8Array([0, 0, 0, 0])).toString("base64");
    client.emit({ type: "audio.input", data: pcmBase64, mimeType: "audio/pcm;rate=24000" });
    await flush();

    // Reasoning at t=7s (t=6s + 1s advance below).
    await advance(1_000);
    // Still audio active, so narration should have been gated.
    let narrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(narrations).toHaveLength(0);

    // More audio frames from t=7s to t=9s.
    client.emit({ type: "audio.input", data: pcmBase64, mimeType: "audio/pcm;rate=24000" });
    await advance(2_000);
    client.emit({ type: "audio.end" });
    await flush();
    // After audio.end + poke(), narration should now proceed (grace closed at 6s).
    await advance(1);

    narrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);

    await session.close();
  });

  it("PTT fallback does NOT engage for local provider (audio.input frames don't suppress narration)", async () => {
    const hermes = scriptedHermes([
      { delayMs: 7_000, event: { event: "reasoning.available", text: "thinking" } as HermesRunEvent },
      { delayMs: 30_000, event: { event: "run.completed", output: "done" } as HermesRunEvent },
    ]);
    const adapter = new RecordingNarrationAdapter();
    const logger = fakeLogger();
    const { client, session } = await bootWithRun(
      testConfig({ realtime: { provider: "local", model: "hf-realtime-voice" } }),
      adapter,
      hermes,
      logger,
    );

    await advance(6_000);
    const pcmBase64 = Buffer.from(new Uint8Array([0, 0, 0, 0])).toString("base64");
    client.emit({ type: "audio.input", data: pcmBase64, mimeType: "audio/pcm;rate=24000" });
    await flush();

    // Reasoning at t=7s. Local provider does NOT engage PTT — narration should deliver.
    await advance(1_000);
    const narrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);

    await session.close();
  });

  it("PTT barge-in cancels narration and terminal cutoff is suppressed after user input", async () => {
    // Narration at ~t=6s, then PTT audio at t=7s (barge-in), then audio.end, then run.completed.
    // Expect user_barge_in cancel; expect NO narration_cutoff cancel at terminal (lastUserInputAt > lastNarrationAt).
    const hermes = scriptedHermes([
      { delayMs: 6_000, event: { event: "reasoning.available", text: "step one" } as HermesRunEvent },
      { delayMs: 6_000, event: { event: "run.completed", output: "done" } as HermesRunEvent },
    ]);
    const adapter = new RecordingNarrationAdapter();
    const logger = fakeLogger();
    const { client, session } = await bootWithRun(testConfig(), adapter, hermes, logger);

    // Narration at ~t=6s (grace boundary, reasoning arrives right after).
    await advance(6_000);
    const narrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(narrations.length).toBeGreaterThanOrEqual(1);

    // t=7s: first PTT audio frame (should barge-in cancel).
    await advance(1_000);
    const pcmBase64 = Buffer.from(new Uint8Array([0, 0, 0, 0])).toString("base64");
    client.emit({ type: "audio.input", data: pcmBase64, mimeType: "audio/pcm;rate=24000" });
    await flush();

    const bargeCancel = adapter.calls.find(
      (c) => c.kind === "cancelResponse" && c.reason === "user_barge_in",
    );
    expect(bargeCancel).toBeDefined();

    // audio.end and then run completes.
    client.emit({ type: "audio.end" });
    await flush();
    await advance(5_000); // reach t=12s -> run.completed
    await flush();

    // No narration_cutoff should have been issued at terminal because
    // lastUserInputAt (t≈7s) > lastNarrationAt (t≈6s).
    const cutoff = adapter.calls.find(
      (c) => c.kind === "cancelResponse" && c.reason === "narration_cutoff",
    );
    expect(cutoff).toBeUndefined();

    await session.close();
  });
});

// ---------- Long-run narration QA harness ----------
//
// Timing arithmetic for the test below:
//   Config: graceMs=6000  minGapMs=12000  heartbeatIdleMs=15000  heartbeatMax=1
//
//   t= 0s  run start; grace window opens (narrator created, createdAt=T0)
//   t= 6s  grace closes → state=active; scheduleHeartbeatCheck → Timer A at T0+21s
//           (idleAnchor = createdAt+graceMs = T0+6s, wait = 15s)
//   t=10s  reasoning.available → narration #1 delivered; lastSuccessAt=T0+10s
//           scheduleHeartbeatCheck → Timer B at T0+25s
//   t=12s  tool.started → pending; min-gap elapsed=2s < 12s → tick deferred to T0+22s
//   t=21s  Timer A fires: idleAnchor=T0+10s, now−anchor=11s < 15s → Timer C at T0+25s
//   t=22s  min-gap tick → narration #2 (tool.started text) delivered; lastSuccessAt=T0+22s
//           scheduleHeartbeatCheck → Timer D at T0+22+15=T0+37s
//   t=25s  Timers B+C fire: idleAnchor=T0+22s, now−anchor=3s < 15s → each reschedule at T0+37s
//   t=37s  Timer D (+ duplicates) fire: idleAnchor=T0+22s, now−anchor=15s ≥ 15s
//           → HEARTBEAT_TEXT delivered as narration #3; heartbeatCount=1 ≥ heartbeatMax=1
//           → state=offer_wait; setPending(OFFER_WAIT_TEXT); scheduleTimeout(tickOfferWait, 0ms)
//           tickOfferWait at T0+37s: elapsed=0 < 12s → reschedule at T0+49s
//   t=40s  ← end of silence window; exactly ONE heartbeat has fired ✓
//   t=45s  reasoning.available → state=offer_wait → ignored
//   t=49s  tickOfferWait → narration #4 (OFFER_WAIT_TEXT) delivered; state=silenced
//   t=50s  run.completed → onTerminal() → cancelResponse("narration_cutoff") → sendToolResponse
//
//   Consecutive narration gaps:
//     #1→#2: 22s − 10s = 12s ≥ 12s ✓
//     #2→#3: 37s − 22s = 15s ≥ 12s ✓
//     #3→#4: 49s − 37s = 12s ≥ 12s ✓

describe("long run narration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces exactly one heartbeat in the silence window, enforces minGapMs spacing, and issues narration_cutoff before terminal tool response", async () => {
    const config = testConfig({
      realtime: { provider: "local", model: "hf-realtime-voice" },
      narration: {
        graceMs: 6_000,
        minGapMs: 12_000,
        heartbeatIdleMs: 15_000, // heartbeat at lastSuccessAt + 15 000 ms
        heartbeatMax: 1,          // exactly one heartbeat → offer_wait, no second
        audioGapMs: 0,
      },
    });

    const hermes = scriptedHermes([
      // delayMs = real-timer wait between the PREVIOUS yield and this yield
      { delayMs: 10_000, event: { event: "reasoning.available", text: "still working on it" } as HermesRunEvent },
      { delayMs:  2_000, event: { event: "tool.started",        tool: "summarize_file"       } as HermesRunEvent },
      { delayMs: 33_000, event: { event: "reasoning.available", text: "almost there"         } as HermesRunEvent }, // t=45s; ignored (offer_wait)
      { delayMs:  5_000, event: { event: "run.completed",       output: "done"               } as HermesRunEvent }, // t=50s
    ]);

    const adapter = new RecordingNarrationAdapter();
    const logger = fakeLogger();
    const { client, session } = await bootWithRun(config, adapter, hermes, logger);

    // ── (1) No narration delivered before grace closes (t < 6s) ──────────
    await advance(6_000); // grace closes at t=6s; no events yet
    const before6s = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(before6s).toHaveLength(0);

    // ── Advance through the full run timeline step-by-step ────────────────
    await advance(4_000);  // → t=10s: reasoning.available → narration #1
    await advance(2_000);  // → t=12s: tool.started queued (min-gap not elapsed)
    await advance(10_000); // → t=22s: min-gap tick → narration #2 (tool.started)
    await advance(15_000); // → t=37s: heartbeat timer → narration #3 (HEARTBEAT_TEXT)
    await advance(3_000);  // → t=40s: end of silence window; offer_wait pending at t=49s

    // ── (3) Exactly ONE heartbeat in the 12s-to-40s silence window ────────
    const heartbeats = adapter.calls.filter(
      (c) => c.kind === "sendNarration" && c.text === HEARTBEAT_TEXT,
    );
    expect(heartbeats).toHaveLength(1);

    await advance(5_000);  // → t=45s: second reasoning ignored (offer_wait state)
    await advance(5_000);  // → t=50s: tickOfferWait at t=49s + run.completed at t=50s
    await flush();         // drain onTerminal async chain (cancelResponse → sendToolResponse)

    // ── (2) All narrations spaced ≥ minGapMs (12 000 ms) apart ───────────
    const allNarrations = adapter.calls.filter((c) => c.kind === "sendNarration");
    expect(allNarrations.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < allNarrations.length; i++) {
      const prev = allNarrations[i - 1]!;
      const curr = allNarrations[i]!;
      expect(curr.at - prev.at).toBeGreaterThanOrEqual(12_000);
    }

    // ── (4) cancelResponse("narration_cutoff") strictly before sendToolResponse ──
    const cutoff = adapter.calls.find(
      (c) => c.kind === "cancelResponse" && c.reason === "narration_cutoff",
    );
    const toolResponse = adapter.calls.find((c) => c.kind === "sendToolResponse");
    expect(cutoff).toBeDefined();
    expect(toolResponse).toBeDefined();
    if (cutoff && toolResponse) {
      expect(cutoff.seq).toBeLessThan(toolResponse.seq);
    }

    // ── (5) No session.error frames sent to the client ────────────────────
    const errorFrames = client.sent.filter((m) => m.type === "session.error");
    expect(errorFrames).toHaveLength(0);

    await session.close();
  });
});
