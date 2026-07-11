import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import {
  AGENT_PROGRESS_PREFIX,
  APPROVAL_TEXT,
  HEARTBEAT_TEXT,
  narrationFrame,
  OFFER_WAIT_TEXT,
  RunNarrator,
  TOOL_ERROR_TEXT,
} from "../src/application/live-gateway/run-narrator.js";

function makeConfig(overrides: Partial<AppConfig["narration"]> = {}): AppConfig["narration"] {
  return {
    enabled: true,
    graceMs: 100,
    minGapMs: 200,
    heartbeatIdleMs: 500,
    heartbeatMax: 2,
    reasoningMode: "paraphrase",
    audioGapMs: 800,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function flushMicrotasks(): Promise<void> {
  // Allow queued promise resolutions from deliver() to settle.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushMicrotasks();
}

describe("RunNarrator exported constants", () => {
  it("AGENT_PROGRESS_PREFIX is a strict prefix of all 5 framed outputs", () => {
    expect(narrationFrame("hello").startsWith(AGENT_PROGRESS_PREFIX)).toBe(true);
    expect(HEARTBEAT_TEXT.startsWith(AGENT_PROGRESS_PREFIX)).toBe(true);
    expect(TOOL_ERROR_TEXT.startsWith(AGENT_PROGRESS_PREFIX)).toBe(true);
    expect(APPROVAL_TEXT.startsWith(AGENT_PROGRESS_PREFIX)).toBe(true);
    expect(OFFER_WAIT_TEXT.startsWith(AGENT_PROGRESS_PREFIX)).toBe(true);
  });
});

describe("RunNarrator behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("(1) grace suppression: reasoning during grace is not delivered until graceMs elapses", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r1",
      config: makeConfig({ graceMs: 100 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    narrator.onEvent({ kind: "reasoning", text: "hello" });
    await advance(50);
    expect(deliver).not.toHaveBeenCalled();

    await advance(60); // total 110ms > graceMs
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(narrationFrame("hello"));

    narrator.dispose();
  });

  it("(2) min-gap: two reasoning events within min-gap → exactly 1 delivery (latest wins)", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r2",
      config: makeConfig({ graceMs: 100, minGapMs: 5000, heartbeatIdleMs: 60_000 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    // Both events during grace — drop-not-queue: second overwrites first
    // before grace ends, so only "second" is delivered.
    narrator.onEvent({ kind: "reasoning", text: "first" });
    narrator.onEvent({ kind: "reasoning", text: "second" });
    await advance(150); // past grace

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(narrationFrame("second"));

    narrator.dispose();
  });

  it("(3) deferred first tool_started retry: gated then delivered on retry", async () => {
    const deliver = vi
      .fn<(text: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r3",
      config: makeConfig({ graceMs: 50, minGapMs: 100, heartbeatIdleMs: 10_000 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    await advance(60);
    narrator.onEvent({ kind: "tool_started", tool: "bash" });
    await advance(20);
    // first attempt should have been called and returned false
    expect(deliver).toHaveBeenCalledTimes(1);

    // Trigger retry via poke().
    narrator.poke();
    await advance(20);

    expect(deliver).toHaveBeenCalledTimes(2);
    const expected = narrationFrame("Started working on it");
    expect(deliver.mock.calls[0]?.[0]).toBe(expected);
    expect(deliver.mock.calls[1]?.[0]).toBe(expected);

    narrator.dispose();
  });

  it("(4) gated-delivery retry via poke() for reasoning", async () => {
    const deliver = vi
      .fn<(text: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r4",
      config: makeConfig({ graceMs: 50, minGapMs: 100 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    await advance(60);
    narrator.onEvent({ kind: "reasoning", text: "hi" });
    await advance(20);
    expect(deliver).toHaveBeenCalledTimes(1); // gated

    narrator.poke();
    await advance(20);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]?.[0]).toBe(narrationFrame("hi"));

    narrator.dispose();
  });

  it("(5) heartbeat fires after heartbeatIdleMs with no successful delivery", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r5",
      config: makeConfig({ graceMs: 50, minGapMs: 100, heartbeatIdleMs: 300, heartbeatMax: 5 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    // Advance well past grace + heartbeatIdle
    await advance(400);
    expect(deliver).toHaveBeenCalledWith(HEARTBEAT_TEXT);

    narrator.dispose();
  });

  it("(6) heartbeatMax → OFFER_WAIT → SILENCED, no further deliveries", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r6",
      config: makeConfig({ graceMs: 50, minGapMs: 100, heartbeatIdleMs: 200, heartbeatMax: 2 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    // grace 50 + first heartbeat window 200 → first heartbeat around t=250
    // second heartbeat window minGap 100 + idle 200 after first success → second at ~t=250+~200(from lastSuccess)
    // Advance generously to cover both + offer_wait.
    await advance(2000);

    const heartbeatCalls = deliver.mock.calls.filter((c) => c[0] === HEARTBEAT_TEXT).length;
    const offerWaitCalls = deliver.mock.calls.filter((c) => c[0] === OFFER_WAIT_TEXT).length;

    expect(heartbeatCalls).toBe(2);
    expect(offerWaitCalls).toBe(1);

    const countBeforeSilence = deliver.mock.calls.length;
    // Advance further; no new deliveries.
    await advance(5000);
    expect(deliver.mock.calls.length).toBe(countBeforeSilence);

    narrator.dispose();
  });

  it("(7) approval_request suspends heartbeats", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r7",
      config: makeConfig({ graceMs: 50, minGapMs: 100, heartbeatIdleMs: 200, heartbeatMax: 10 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    await advance(60); // past grace
    narrator.onEvent({ kind: "approval_request" });
    await advance(50);
    // Approval delivered
    expect(deliver).toHaveBeenCalledWith(APPROVAL_TEXT);
    const callsAfterApproval = deliver.mock.calls.length;

    // Advance well past what would trigger a heartbeat.
    await advance(3000);
    const heartbeatCalls = deliver.mock.calls.filter((c) => c[0] === HEARTBEAT_TEXT).length;
    expect(heartbeatCalls).toBe(0);
    expect(deliver.mock.calls.length).toBe(callsAfterApproval);

    narrator.dispose();
  });

  it("(8) onApprovalResolved resumes heartbeats", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r8",
      config: makeConfig({ graceMs: 50, minGapMs: 100, heartbeatIdleMs: 200, heartbeatMax: 10 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    await advance(60);
    narrator.onEvent({ kind: "approval_request" });
    await advance(50);
    expect(deliver).toHaveBeenCalledWith(APPROVAL_TEXT);

    await advance(1000);
    expect(deliver.mock.calls.filter((c) => c[0] === HEARTBEAT_TEXT).length).toBe(0);

    narrator.onApprovalResolved();
    await advance(500);
    expect(deliver.mock.calls.filter((c) => c[0] === HEARTBEAT_TEXT).length).toBeGreaterThanOrEqual(1);

    narrator.dispose();
  });

  it("(9) onTerminal after successful delivery → cancelNarration called exactly once", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const cancelNarration = vi.fn().mockResolvedValue(undefined);
    const narrator = new RunNarrator({
      runId: "r9",
      config: makeConfig({ graceMs: 50, minGapMs: 100 }),
      deliver,
      cancelNarration,
      logger: makeLogger(),
    });

    await advance(60);
    narrator.onEvent({ kind: "reasoning", text: "hi" });
    await advance(20);
    expect(deliver).toHaveBeenCalledTimes(1);

    await narrator.onTerminal();
    expect(cancelNarration).toHaveBeenCalledTimes(1);
  });

  it("(10) onTerminal with ZERO deliveries → cancelNarration NOT called", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const cancelNarration = vi.fn().mockResolvedValue(undefined);
    const narrator = new RunNarrator({
      runId: "r10",
      config: makeConfig(),
      deliver,
      cancelNarration,
      logger: makeLogger(),
    });

    await narrator.onTerminal();
    expect(cancelNarration).toHaveBeenCalledTimes(0);
  });

  it("(11) dispose() stops everything — deliver call count frozen after dispose", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r11",
      config: makeConfig({ graceMs: 50, minGapMs: 100, heartbeatIdleMs: 200, heartbeatMax: 10 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    await advance(60);
    narrator.onEvent({ kind: "reasoning", text: "hi" });
    await advance(50);
    const frozen = deliver.mock.calls.length;
    expect(frozen).toBeGreaterThanOrEqual(1);

    narrator.dispose();
    await advance(5000);
    expect(deliver.mock.calls.length).toBe(frozen);

    // Subsequent public calls are no-ops
    narrator.onEvent({ kind: "reasoning", text: "should not deliver" });
    narrator.poke();
    narrator.onApprovalResolved();
    await advance(1000);
    expect(deliver.mock.calls.length).toBe(frozen);
  });

  it("(12) deliver throwing never propagates", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("boom"));
    const logger = makeLogger();
    const narrator = new RunNarrator({
      runId: "r12",
      config: makeConfig({ graceMs: 50, minGapMs: 100, heartbeatIdleMs: 500 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger,
    });

    await advance(60);
    expect(() => narrator.onEvent({ kind: "reasoning", text: "hi" })).not.toThrow();
    // Advancing timers should not produce unhandled rejections.
    await advance(200);
    expect(deliver).toHaveBeenCalled();
    // warn logged for the throw
    expect(logger.warn).toHaveBeenCalled();

    narrator.dispose();
  });

  it("(13) reasoningMode=off → reasoning skipped but heartbeats still fire", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r13",
      config: makeConfig({
        graceMs: 50,
        minGapMs: 100,
        heartbeatIdleMs: 300,
        heartbeatMax: 5,
        reasoningMode: "off",
      }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    await advance(60);
    narrator.onEvent({ kind: "reasoning", text: "should be skipped" });
    await advance(100);

    const reasoningDeliveries = deliver.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("should be skipped"),
    ).length;
    expect(reasoningDeliveries).toBe(0);

    // Heartbeats still fire
    await advance(500);
    expect(deliver.mock.calls.filter((c) => c[0] === HEARTBEAT_TEXT).length).toBeGreaterThanOrEqual(1);

    narrator.dispose();
  });

  it("(14a) tool_completed error=true → TOOL_ERROR_TEXT delivered", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r14a",
      config: makeConfig({ graceMs: 50, minGapMs: 100 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    await advance(60);
    narrator.onEvent({ kind: "tool_completed", tool: "bash", error: true });
    await advance(20);
    expect(deliver).toHaveBeenCalledWith(TOOL_ERROR_TEXT);

    narrator.dispose();
  });

  it("(14b) tool_completed error=false → NO delivery", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "r14b",
      config: makeConfig({ graceMs: 50, minGapMs: 100, heartbeatIdleMs: 10_000 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    await advance(60);
    narrator.onEvent({ kind: "tool_completed", tool: "bash", error: false });
    await advance(200);
    expect(deliver).not.toHaveBeenCalled();

    narrator.dispose();
  });

  it("subsequent tool_started events are ignored (only first one narrates)", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "extra",
      config: makeConfig({ graceMs: 50, minGapMs: 50, heartbeatIdleMs: 10_000 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    await advance(60);
    narrator.onEvent({ kind: "tool_started", tool: "bash", preview: "one" });
    await advance(30);
    narrator.onEvent({ kind: "tool_started", tool: "read", preview: "two" });
    await advance(200);

    const toolCalls = deliver.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("Started working on it"),
    );
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]?.[0]).toBe(narrationFrame("Started working on it: one"));

    narrator.dispose();
  });

  it("terminal event via onEvent is a no-op (does not crash, does not narrate)", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const narrator = new RunNarrator({
      runId: "term",
      config: makeConfig({ graceMs: 50, heartbeatIdleMs: 60_000 }),
      deliver,
      cancelNarration: vi.fn().mockResolvedValue(undefined),
      logger: makeLogger(),
    });

    await advance(60);
    expect(() =>
      narrator.onEvent({ kind: "terminal", status: "completed" }),
    ).not.toThrow();
    await advance(500);
    expect(deliver).not.toHaveBeenCalled();

    narrator.dispose();
  });

  it("cancelNarration throwing in onTerminal is swallowed", async () => {
    const deliver = vi.fn().mockResolvedValue(true);
    const cancelNarration = vi.fn().mockRejectedValue(new Error("cancel boom"));
    const logger = makeLogger();
    const narrator = new RunNarrator({
      runId: "cancel-throw",
      config: makeConfig({ graceMs: 50, minGapMs: 100 }),
      deliver,
      cancelNarration,
      logger,
    });

    await advance(60);
    narrator.onEvent({ kind: "reasoning", text: "hi" });
    await advance(20);
    expect(deliver).toHaveBeenCalled();

    await expect(narrator.onTerminal()).resolves.toBeUndefined();
    expect(cancelNarration).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});
