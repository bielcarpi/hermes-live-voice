import WebSocket from "ws";
import { normalizePcm16Audio } from "../../../domain/audio/pcm.js";
import type { AppConfig } from "../../../config.js";
import type { RealtimeResponseTruncation } from "../../../domain/protocol/client-protocol.js";
import { OPENAI_HERMES_LIVE_TOOLS } from "../../../application/live-gateway/tool-definitions.js";
import type {
  LiveModelAdapter,
  LiveModelAudio,
  LiveModelCallbacks,
  LiveModelConnectParams,
  LiveModelEvent,
  LiveModelSession,
  LiveToolCall,
} from "../../../application/live-gateway/ports/realtime-model.port.js";

export const LOCAL_REALTIME_PCM_SAMPLE_RATE = 16_000;

export function buildLocalSessionUpdate(
  config: AppConfig["local"],
  systemInstruction: string,
): { type: "session.update"; session: Record<string, unknown> } {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: systemInstruction,
      audio: {
        output: {
          voice: config.voice,
        },
      },
      tools: OPENAI_HERMES_LIVE_TOOLS,
      tool_choice: "auto",
    },
  };
}

export function buildLocalRealtimeAudioAppend(
  audio: LiveModelAudio,
): { type: "input_audio_buffer.append"; audio: string } {
  return {
    type: "input_audio_buffer.append",
    audio: normalizePcm16Audio(audio, LOCAL_REALTIME_PCM_SAMPLE_RATE).data,
  };
}

export function normalizeLocalRealtimeEvent(event: unknown): LiveModelEvent[] {
  const events: LiveModelEvent[] = [];
  const root = event as any;

  if (
    (root?.type === "response.output_audio.delta" || root?.type === "response.audio.delta") &&
    typeof root.delta === "string"
  ) {
    const audioEvent: LiveModelEvent = {
      type: "audio",
      audio: { data: root.delta, mimeType: "audio/pcm;rate=16000" },
    };
    if (audioEvent.type === "audio") {
      if (typeof root.item_id === "string") {
        audioEvent.audio.itemId = root.item_id;
      }
      if (typeof root.content_index === "number") {
        audioEvent.audio.contentIndex = root.content_index;
      }
    }
    events.push(audioEvent);
  }

  if (
    (root?.type === "response.output_audio_transcript.delta" ||
      root?.type === "response.audio_transcript.delta" ||
      root?.type === "response.output_text.delta") &&
    typeof root.delta === "string"
  ) {
    events.push({ type: "text", text: root.delta });
  }

  if (root?.type === "input_audio_buffer.speech_started") {
    events.push({
      type: "input_speech_started",
      provider: "local",
      ...(typeof root.item_id === "string" ? { itemId: root.item_id } : {}),
      ...(typeof root.audio_start_ms === "number" ? { audioStartMs: root.audio_start_ms } : {}),
    });
  }

  if (root?.type === "input_audio_buffer.speech_stopped") {
    events.push({
      type: "input_speech_stopped",
      provider: "local",
      ...(typeof root.duration_s === "number" ? { durationS: root.duration_s } : {}),
      ...(typeof root.audio_end_ms === "number" ? { audioEndMs: root.audio_end_ms } : {}),
    });
  }

  if (root?.type === "response.function_call_arguments.done") {
    const call: LiveToolCall = {
      id: root.call_id,
      name: String(root.name ?? ""),
      args: parseLocalArgs(root.arguments ?? {}),
    };
    if (call.name.length > 0) {
      events.push({ type: "tool_call", call });
    }
  }

  events.push({ type: "raw", message: event });
  return events;
}

export class LocalRealtimeAdapter implements LiveModelAdapter {
  constructor(private readonly config: AppConfig["local"]) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    const ws = new WebSocket(this.config.baseUrl);
    const session = new LocalRealtimeSession(ws, this.config, params.callbacks);

    return await new Promise<LiveModelSession>((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        onInitialError(new Error("Local Realtime session did not acknowledge session.created."));
      }, 10_000);

      const cleanup = () => {
        clearTimeout(readyTimeout);
        ws.off("error", onInitialError);
        ws.off("close", onInitialClose);
        ws.off("open", onOpen);
        ws.off("message", onInitialMessage);
      };

      const onInitialError = (error: unknown) => {
        cleanup();
        closeWebSocket(ws, 1011, "Local Realtime session start failed");
        reject(error);
      };

      const onInitialClose = (code: number, reason: Buffer) => {
        cleanup();
        reject(rewriteLocalCloseError(code, reason.toString("utf8")));
      };

      const onOpen = () => {
        ws.send(JSON.stringify(buildLocalSessionUpdate(this.config, params.systemInstruction)));
        params.callbacks.onOpen?.();
      };

      const onInitialMessage = (raw: WebSocket.RawData) => {
        const event = parseLocalEvent(raw);
        if (event?.type === "session.created") {
          cleanup();
          resolve(session);
        } else if (event?.type === "error") {
          onInitialError(event.error ?? event);
        }
      };

      ws.once("error", onInitialError);
      ws.once("close", onInitialClose);
      ws.once("open", onOpen);
      ws.on("message", onInitialMessage);
    });
  }
}

class LocalRealtimeSession implements LiveModelSession {
  private readonly handledToolCalls = new Set<string>();
  private responseActive = false;
  private responsePending = false;
  private toolResponsePending = false;
  private cancelling = false;
  private cancelFallbackTimer?: NodeJS.Timeout;

  private get busy(): boolean {
    return this.responseActive || this.responsePending;
  }

  constructor(
    private readonly ws: WebSocket,
    private readonly _config: AppConfig["local"],
    private readonly callbacks: LiveModelCallbacks,
  ) {
    this.ws.on("message", (raw) => this.handleMessage(raw));
    this.ws.on("close", (code, reason) => callbacks.onClose?.({ code, reason: reason.toString("utf8") }));
    this.ws.on("error", (error) => callbacks.onError?.(error));
  }

  async sendRealtimeAudio(audio: LiveModelAudio): Promise<void> {
    this.sendJson(buildLocalRealtimeAudioAppend(audio));
  }

  async sendText(text: string): Promise<void> {
    this.sendJson({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    if (!this.busy) {
      this.createResponse();
    }
  }

  async sendNarration(text: string): Promise<boolean> {
    if (this.busy) return false;
    this.sendJson({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.createResponse();
    return true;
  }

  async sendAudioStreamEnd(): Promise<void> {
    // no-op: backend VAD auto-closes turns, no commit handler
  }

  async cancelResponse(_reason?: string, truncate?: RealtimeResponseTruncation): Promise<boolean> {
    const shouldCancel = this.responsePending || this.responseActive;
    if (!shouldCancel && !truncate) {
      return false;
    }
    if (shouldCancel) {
      this.sendJson({ type: "response.cancel" });
      this.cancelling = true;
      if (this.cancelFallbackTimer) {
        clearTimeout(this.cancelFallbackTimer);
      }
      this.cancelFallbackTimer = setTimeout(() => {
        this.cancelFallbackTimer = undefined;
        if (this.ws.readyState !== WebSocket.OPEN) return;
        this.cancelling = false;
        this.responsePending = false;
        this.responseActive = false;
        if (this.toolResponsePending) {
          this.toolResponsePending = false;
          this.createResponse();
        }
      }, 2000);
    }
    // truncate param accepted but NOT sent (no conversation.item.truncate)
    return true;
  }

  async sendToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    if (!call.id) {
      throw new Error(`Local function call ${call.name} did not include a call_id.`);
    }
    this.sendJson({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.id, output: JSON.stringify(response) },
    });
    if (!this.busy) {
      this.createResponse();
    } else {
      // Response still in flight (e.g. narration) — defer follow-up until it settles.
      this.toolResponsePending = true;
    }
  }

  async close(): Promise<void> {
    if (this.cancelFallbackTimer) {
      clearTimeout(this.cancelFallbackTimer);
      this.cancelFallbackTimer = undefined;
    }
    closeWebSocket(this.ws, 1000, "session closed");
  }

  private handleMessage(raw: WebSocket.RawData): void {
    const event = parseLocalEvent(raw);
    if (!event) {
      this.callbacks.onError?.(new Error("Local Realtime event was not valid JSON."));
      return;
    }
    this.trackResponseState(event);
    if ((event as { type?: string }).type === "error") {
      this.callbacks.onError?.((event as { error?: unknown }).error ?? event);
    }
    for (const modelEvent of normalizeLocalRealtimeEvent(event)) {
      if (modelEvent.type === "tool_call") {
        const key = modelEvent.call.id ?? `${modelEvent.call.name}:${JSON.stringify(modelEvent.call.args)}`;
        if (this.handledToolCalls.has(key)) {
          continue;
        }
        this.handledToolCalls.add(key);
      }
      this.callbacks.onEvent(modelEvent);
    }
  }

  private sendJson(payload: unknown): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Local Realtime WebSocket is not open.");
    }
    this.ws.send(JSON.stringify(payload));
  }

  private createResponse(): void {
    this.sendJson({ type: "response.create" });
    this.responsePending = true;
  }

  private trackResponseState(event: any): void {
    if (event?.type === "response.created") {
      this.responsePending = false;
      this.responseActive = true;
    } else if (
      event?.type === "response.done" ||
      event?.type === "response.cancelled" ||
      event?.type === "response.failed" ||
      event?.response?.status === "completed" ||
      event?.response?.status === "cancelled" ||
      event?.response?.status === "failed"
    ) {
      if (this.cancelFallbackTimer) {
        clearTimeout(this.cancelFallbackTimer);
        this.cancelFallbackTimer = undefined;
      }
      this.cancelling = false;
      this.responsePending = false;
      this.responseActive = false;
      if (this.toolResponsePending) {
        this.toolResponsePending = false;
        this.createResponse();
      }
    }
  }
}

function closeWebSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.close(code, reason);
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.once("open", () => ws.close(code, reason));
  }
}

function parseLocalEvent(raw: WebSocket.RawData): any | undefined {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}

function rewriteLocalCloseError(code: number, reason: string): Error {
  if (code === 1008 && reason.toLowerCase().includes("concurrent session")) {
    return new Error(
      "Local Realtime WebSocket closed: single-session limit — only one concurrent session is supported.",
    );
  }
  return new Error(`Local Realtime WebSocket closed before session start: ${code} ${reason}`);
}

function parseLocalArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
