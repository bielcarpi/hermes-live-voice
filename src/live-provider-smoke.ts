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
  const errors: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  let session: Awaited<ReturnType<typeof adapter.connect>> | undefined;
  let openCallback = false;
  let closeEvent: Record<string, unknown> | undefined;
  let closing = false;
  let resolveOpen: () => void = () => undefined;
  const openSignal = new Promise<void>((resolve) => {
    resolveOpen = resolve;
  });

  try {
    session = await withTimeout(
      adapter.connect({
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
          onError: (error) => {
            if (!closing) {
              errors.push(errorToMessage(error));
            }
          },
          onEvent: (event) => {
            events.push(summarizeLiveEvent(event));
          },
        },
      }),
      timeoutMs,
      `${config.realtime.provider} realtime session did not connect within ${timeoutMs}ms.`,
    );

    if (!openCallback) {
      await Promise.race([openSignal, delay(Math.min(1_000, timeoutMs))]);
    }
    if (errors.length > 0) {
      throw new Error(`${config.realtime.provider} provider emitted an error during startup: ${errors[0]}`);
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
    await session?.close().catch(() => undefined);
    throw error;
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
      return { type: "audio", mimeType: event.audio.mimeType };
    case "text":
      return { type: "text" };
    case "tool_call":
      return { type: "tool_call", name: event.call.name };
    case "input_speech_started":
      return { type: "input_speech_started", provider: event.provider };
    case "response":
      return { type: "response", status: event.status };
  }
}

function summarizeCloseEvent(event: unknown): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") {
    return event === undefined ? undefined : { value: String(event) };
  }
  return {
    ...(typeof (event as { code?: unknown }).code === "number" ? { code: (event as { code: number }).code } : {}),
    ...(typeof (event as { reason?: unknown }).reason === "string" ? { reason: (event as { reason: string }).reason } : {}),
  };
}
