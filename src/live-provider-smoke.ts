import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import { assertRealtimeProviderConfig } from "./config.js";
import { createLiveModelAdapter } from "./adapters/outbound/realtime/factory.js";
import { buildSystemInstruction } from "./application/live-gateway/system-instruction.js";
import type { LiveModelEvent, LiveToolCall } from "./application/live-gateway/ports/realtime-model.port.js";
import { errorToMessage } from "./domain/error-message.js";

export const LOCAL_FUNCTIONAL_PROVIDER_SMOKE_TIMEOUT_MS = 120_000;
const MAX_RETAINED_SMOKE_EVENTS = 64;

export interface LiveProviderSmokeReport {
  ok: true;
  provider: Exclude<AppConfig["realtime"]["provider"], "mock">;
  model: string;
  connected: true;
  openCallback: boolean;
  elapsedMs: number;
  eventCount: number;
  sampleEvents: Array<Record<string, unknown>>;
  functional?: {
    checked: true;
    toolCall: true;
    spokenReceipt: true;
    elapsedMs: number;
  };
  closeEvent?: Record<string, unknown>;
}

export interface LiveProviderSmokeOptions {
  timeoutMs?: number;
  verifyToolCall?: boolean;
}

export async function runLiveProviderSmoke(config: AppConfig, options: LiveProviderSmokeOptions = {}): Promise<LiveProviderSmokeReport> {
  if (config.realtime.provider === "mock") {
    throw new Error("Set HERMES_LIVE_PROVIDER=local, gemini, or openai to smoke test a real provider session.");
  }

  assertRealtimeProviderConfig(config);
  if (options.verifyToolCall && config.realtime.provider !== "local") {
    throw new Error("Functional provider smoke is currently supported only for managed local voice.");
  }

  const timeoutMs = options.timeoutMs ?? config.server.providerReadyTimeoutMs;
  const adapter = createLiveModelAdapter(config);
  const sessionId = `live_provider_smoke_${Date.now()}`;
  const startedAt = Date.now();
  const safetyIdentifier = createHash("sha256").update(`hermes-live-provider-smoke:${sessionId}`).digest("hex");
  const notificationToken = createHash("sha256").update(`notification:${sessionId}`).digest("hex").slice(0, 32);
  const functionalTools = [
    "start_background_task",
    "list_background_tasks",
    "get_background_task",
    "follow_up_background_task",
    "stop_background_task",
    "pause_voice_input",
  ] as const;
  const events: Array<Record<string, unknown>> = [];
  let eventCount = 0;
  let session: Awaited<ReturnType<typeof adapter.connect>> | undefined;
  let pendingConnect: ReturnType<typeof adapter.connect> | undefined;
  let openCallback = false;
  let providerError = false;
  let closeEvent: Record<string, unknown> | undefined;
  let closing = false;
  let resolveOpen: () => void = () => undefined;
  const openSignal = new Promise<void>((resolve) => {
    resolveOpen = resolve;
  });
  let toolResponseSent = false;
  let receiptAudioObserved = false;
  let functionalSettled = false;
  let resolveToolCall!: (result: { call?: LiveToolCall; error?: string }) => void;
  let resolveReceipt!: (result: { ok?: true; error?: string }) => void;
  const toolCallSignal = new Promise<{ call?: LiveToolCall; error?: string }>((resolve) => {
    resolveToolCall = resolve;
  });
  const receiptSignal = new Promise<{ ok?: true; error?: string }>((resolve) => {
    resolveReceipt = resolve;
  });
  const failFunctionalCheck = (message: string) => {
    if (functionalSettled) return;
    functionalSettled = true;
    resolveToolCall({ error: message });
    resolveReceipt({ error: message });
  };
  const connectTimeoutMessage =
    `${config.realtime.provider} realtime session did not connect within ${timeoutMs}ms.`;
  const callbackErrorMessage = `${config.realtime.provider} provider emitted an error during startup.`;

  try {
    pendingConnect = adapter.connect({
      sessionId,
      systemInstruction:
        options.verifyToolCall
          ? buildSystemInstruction(notificationToken, false, { bound: false, voiceInputPause: true }, true)
          : "You are being opened for a hermes-live provider connection smoke test. Do not call tools unless a user message arrives.",
      availableTools: options.verifyToolCall ? functionalTools : [],
      safetyIdentifier,
      callbacks: {
        onOpen: () => {
          openCallback = true;
          resolveOpen();
        },
        onClose: (event) => {
          closeEvent = summarizeCloseEvent(event);
          if (!closing) failFunctionalCheck("Local voice closed before the functional check completed.");
        },
        onError: (_error) => {
          if (!closing) {
            providerError = true;
            failFunctionalCheck("Local voice reported an error during the functional check.");
          }
        },
        onEvent: (event) => {
          eventCount = Math.min(Number.MAX_SAFE_INTEGER, eventCount + 1);
          if (events.length < MAX_RETAINED_SMOKE_EVENTS) events.push(summarizeLiveEvent(event));
          if (!options.verifyToolCall || functionalSettled) return;
          if (event.type === "tool_call") {
            functionalSettled = true;
            resolveToolCall({ call: event.call });
            return;
          }
          if (toolResponseSent && event.type === "audio" && event.audio.data.length > 0) {
            receiptAudioObserved = true;
          }
          if (event.type === "response" && event.status === "failed") {
            failFunctionalCheck(toolResponseSent
              ? "Local voice could not produce the functional-check receipt."
              : "Local voice did not produce a valid task tool call.");
          } else if (event.type === "response" && event.status === "completed") {
            if (toolResponseSent && receiptAudioObserved) {
              functionalSettled = true;
              resolveReceipt({ ok: true });
            } else if (!toolResponseSent) {
              failFunctionalCheck("Local voice answered directly instead of emitting the required task tool call.");
            }
          }
        },
      },
    });
    session = await withTimeout(
      pendingConnect,
      timeoutMs,
      connectTimeoutMessage,
    );

    if (!openCallback) {
      await Promise.race([openSignal, delay(Math.min(1_000, timeoutMs))]);
    }
    if (providerError) {
      throw new Error(callbackErrorMessage);
    }

    let functional: LiveProviderSmokeReport["functional"];
    if (options.verifyToolCall) {
      const functionalStartedAt = Date.now();
      await session.sendText(
        "Delegate this exact task in the background: reply with exactly PROVIDER SMOKE OK.",
      );
      const toolResult = await withFunctionalTimeout(
        toolCallSignal,
        timeoutMs,
        "Local voice did not emit the required task tool call before the functional-check deadline.",
      );
      if (!toolResult.call || toolResult.error) {
        throw new ProviderFunctionalSmokeError(toolResult.error ?? "Local voice did not emit a task tool call.");
      }
      if (
        toolResult.call.name !== "start_background_task"
        || typeof toolResult.call.args.message !== "string"
        || !toolResult.call.args.message.toUpperCase().includes("PROVIDER SMOKE OK")
      ) {
        throw new ProviderFunctionalSmokeError(
          "Local voice did not preserve the requested work in its task tool call during setup.",
        );
      }
      toolResponseSent = true;
      functionalSettled = false;
      await session.sendToolResponse(toolResult.call, {
        spoken_response: "Local voice is ready.",
        ok: true,
        task_id: "task_provider_smoke",
        status: "accepted",
      });
      const receiptResult = await withFunctionalTimeout(
        receiptSignal,
        timeoutMs,
        "Local voice did not produce the spoken task receipt before the functional-check deadline.",
      );
      if (!receiptResult.ok || receiptResult.error) {
        throw new ProviderFunctionalSmokeError(receiptResult.error ?? "Local voice did not produce the task receipt.");
      }
      functional = {
        checked: true,
        toolCall: true,
        spokenReceipt: true,
        elapsedMs: Date.now() - functionalStartedAt,
      };
    }

    closing = true;
    await session.close();

    return {
      ok: true,
      provider: config.realtime.provider,
      model: config.realtime.model,
      connected: true,
      openCallback,
      elapsedMs: Date.now() - startedAt,
      eventCount,
      sampleEvents: events.slice(0, 8),
      ...(functional ? { functional } : {}),
      ...(closeEvent ? { closeEvent } : {}),
    };
  } catch (error) {
    closing = true;
    if (!session && pendingConnect) {
      void pendingConnect.then((lateSession) => lateSession.close()).catch(() => undefined);
    }
    await session?.close().catch(() => undefined);
    const message = errorToMessage(error);
    if (error instanceof ProviderFunctionalSmokeError) throw error;
    if (message === connectTimeoutMessage || message === callbackErrorMessage) {
      throw new Error(message);
    }
    throw new Error(`${config.realtime.provider} realtime provider smoke failed. Provider details were suppressed.`);
  }
}

class ProviderFunctionalSmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderFunctionalSmokeError";
  }
}

async function withFunctionalTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  try {
    return await withTimeout(promise, timeoutMs, message);
  } catch {
    throw new ProviderFunctionalSmokeError(message);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeLiveEvent(event: LiveModelEvent): Record<string, unknown> {
  switch (event.type) {
    case "audio":
      return { type: "audio" };
    case "text":
      return { type: "text" };
    case "tool_call":
      return { type: "tool_call" };
    case "tool_call_cancelled":
      return { type: "tool_call_cancelled", callCount: event.callIds.length };
    case "input_speech_started":
      return { type: "input_speech_started", provider: event.provider };
    case "input_speech_stopped":
      return { type: "input_speech_stopped", provider: event.provider };
    case "response":
      return { type: "response", status: event.status };
  }
}

function summarizeCloseEvent(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
  const code = (event as { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) && code >= 1_000 && code <= 4_999
    ? { code }
    : undefined;
}
