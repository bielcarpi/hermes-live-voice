import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import { assertRealtimeProviderConfig } from "./config.js";
import { createLiveModelAdapter } from "./adapters/outbound/realtime/factory.js";
import type { LiveModelEvent } from "./application/live-gateway/ports/realtime-model.port.js";
import { errorToMessage } from "./domain/error-message.js";

export interface LiveProviderSmokeReport {
  ok: true;
  provider: Exclude<AppConfig["realtime"]["provider"], "mock">;
  model: string;
  connected: true;
  openCallback: boolean;
  elapsedMs: number;
  eventCount: number;
  sampleEvents: Array<Record<string, unknown>>;
  closeEvent?: Record<string, unknown>;
}

export interface LiveProviderSmokeOptions {
  timeoutMs?: number;
}

export async function runLiveProviderSmoke(config: AppConfig, options: LiveProviderSmokeOptions = {}): Promise<LiveProviderSmokeReport> {
  if (config.realtime.provider === "mock") {
    throw new Error("Set HERMES_LIVE_PROVIDER=gemini or HERMES_LIVE_PROVIDER=openai to smoke test a real provider session.");
  }

  assertRealtimeProviderConfig(config);

  const timeoutMs = options.timeoutMs ?? config.server.providerReadyTimeoutMs;
  const adapter = createLiveModelAdapter(config);
  const sessionId = `live_provider_smoke_${Date.now()}`;
  const startedAt = Date.now();
  const safetyIdentifier = createHash("sha256").update(`hermes-live-provider-smoke:${sessionId}`).digest("hex");
  const events: Array<Record<string, unknown>> = [];
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
  const connectTimeoutMessage =
    `${config.realtime.provider} realtime session did not connect within ${timeoutMs}ms.`;
  const callbackErrorMessage = `${config.realtime.provider} provider emitted an error during startup.`;

  try {
    pendingConnect = adapter.connect({
      sessionId,
      systemInstruction:
        "You are being opened for a hermes-live provider connection smoke test. Do not call tools unless a user message arrives.",
      safetyIdentifier,
      callbacks: {
        onOpen: () => {
          openCallback = true;
          resolveOpen();
        },
        onClose: (event) => {
          closeEvent = summarizeCloseEvent(event);
        },
        onError: (_error) => {
          if (!closing) {
            providerError = true;
          }
        },
        onEvent: (event) => {
          events.push(summarizeLiveEvent(event));
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

    closing = true;
    await session.close();

    return {
      ok: true,
      provider: config.realtime.provider,
      model: config.realtime.model,
      connected: true,
      openCallback,
      elapsedMs: Date.now() - startedAt,
      eventCount: events.length,
      sampleEvents: events.slice(0, 8),
      ...(closeEvent ? { closeEvent } : {}),
    };
  } catch (error) {
    closing = true;
    if (!session && pendingConnect) {
      void pendingConnect.then((lateSession) => lateSession.close()).catch(() => undefined);
    }
    await session?.close().catch(() => undefined);
    const message = errorToMessage(error);
    if (message === connectTimeoutMessage || message === callbackErrorMessage) {
      throw new Error(message);
    }
    throw new Error(`${config.realtime.provider} realtime provider smoke failed. Provider details were suppressed.`);
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
