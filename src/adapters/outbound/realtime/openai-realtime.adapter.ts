import WebSocket from "ws";
import { normalizePcm16Audio } from "../../../domain/audio/pcm.js";
import type { AppConfig } from "../../../config.js";
import {
  type LiveModelAudio,
  type LiveModelEvent,
  type LiveToolCall,
} from "../../../application/live-gateway/ports/realtime-model.port.js";
import type { RealtimeResponseTruncation } from "../../../domain/protocol/client-protocol.js";
import { errorToMessage } from "../../../domain/error-message.js";
import { OPENAI_HERMES_LIVE_TOOLS } from "../../../application/live-gateway/tool-definitions.js";
import type {
  LiveModelAdapter,
  LiveModelCallbacks,
  LiveModelConnectParams,
  LiveModelSession,
} from "../../../application/live-gateway/ports/realtime-model.port.js";

const OPENAI_REALTIME_PCM_INPUT_SAMPLE_RATE = 24_000;
const OPENAI_CANCEL_ACK_TIMEOUT_MS = 2_000;
const OPENAI_HANDSHAKE_TIMEOUT_MS = 10_000;
const OPENAI_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const OPENAI_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const OPENAI_MAX_HANDLED_TOOL_CALLS = 4_096;

export class OpenAIRealtimeAdapter implements LiveModelAdapter {
  constructor(private readonly config: AppConfig["openai"]) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    if (!this.config.apiKey) {
      throw new Error("OPENAI_API_KEY is required when HERMES_LIVE_PROVIDER=openai.");
    }
    const url = buildRealtimeUrl(this.config.baseUrl, this.config.model);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}` };
    if (params.safetyIdentifier) {
      headers["OpenAI-Safety-Identifier"] = params.safetyIdentifier;
    }
    const ws = new WebSocket(url, {
      headers,
      handshakeTimeout: OPENAI_HANDSHAKE_TIMEOUT_MS,
      maxPayload: OPENAI_MAX_EVENT_BYTES,
    });
    const session = new OpenAIRealtimeSession(ws, this.config, params.callbacks);

    return await new Promise<LiveModelSession>((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        onInitialError(new Error("OpenAI Realtime session did not acknowledge session.update."));
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
        closeWebSocket(ws, 1011, "OpenAI Realtime session start failed");
        reject(error instanceof Error ? error : new Error(errorToMessage(error)));
      };
      const onInitialClose = (code: number, reason: Buffer) => {
        cleanup();
        reject(new Error(`OpenAI Realtime WebSocket closed before session start: ${code} ${reason.toString("utf8")}`));
      };
      const onOpen = () => session.configure(params.systemInstruction);
      const onInitialMessage = (raw: WebSocket.RawData) => {
        const event = parseOpenAIEvent(raw);
        if (!event) {
          onInitialError(new Error("OpenAI Realtime event was not valid JSON."));
        } else if (event.type === "session.updated") {
          session.markReady();
          cleanup();
          params.callbacks.onOpen?.();
          resolve(session);
        } else if (event.type === "error") {
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

class OpenAIRealtimeSession implements LiveModelSession {
  private readonly handledToolCalls = new Map<string, string>();
  private responseActive = false;
  private responsePending = false;
  private responseCreateQueued = false;
  private cancellationPending = false;
  private cancelAckTimeout?: ReturnType<typeof setTimeout>;
  private ready = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly config: AppConfig["openai"],
    private readonly callbacks: LiveModelCallbacks,
  ) {
    this.ws.on("message", (raw) => this.handleMessage(raw));
    this.ws.on("close", (code, reason) => {
      this.clearCancelAckTimeout();
      callbacks.onClose?.({ code, reason: reason.toString("utf8") });
    });
    this.ws.on("error", (error) => callbacks.onError?.(error));
  }

  configure(systemInstruction: string): void {
    this.sendJson(buildOpenAISessionUpdate(this.config, systemInstruction));
  }

  markReady(): void {
    this.ready = true;
  }

  async sendRealtimeAudio(audio: LiveModelAudio): Promise<void> {
    this.sendJson(buildOpenAIRealtimeAudioAppend(audio, this.config.inputAudioFormat));
  }

  async sendText(text: string): Promise<void> {
    this.sendJson({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.requestResponse();
  }

  async sendAudioStreamEnd(): Promise<void> {
    if (this.config.turnDetection !== "disabled") {
      return;
    }
    this.sendJson({ type: "input_audio_buffer.commit" });
    this.requestResponse();
  }

  async cancelResponse(_reason?: string, truncate?: RealtimeResponseTruncation): Promise<boolean> {
    const responseInFlight = this.responsePending || this.responseActive;
    if (!responseInFlight && !this.cancellationPending && !truncate) {
      return false;
    }
    if (responseInFlight && !this.cancellationPending) {
      this.beginCancellation();
    }
    if (truncate) {
      this.sendJson(buildOpenAIConversationItemTruncate(truncate));
    }
    return true;
  }

  async sendToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    if (!call.id) {
      throw new Error(`OpenAI function call ${call.name} did not include a call_id.`);
    }
    this.sendJson({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: call.id, output: JSON.stringify(response) },
    });
    this.requestResponse();
  }

  async close(): Promise<void> {
    this.clearCancelAckTimeout();
    this.responseCreateQueued = false;
    closeWebSocket(this.ws, 1000, "session closed");
  }

  private handleMessage(raw: WebSocket.RawData): void {
    const event = parseOpenAIEvent(raw);
    if (!event) {
      this.handleProviderError(new Error("OpenAI Realtime event was not valid JSON."), true);
      return;
    }
    if ((event as { type?: string }).type === "error") {
      this.handleProviderError((event as { error?: unknown }).error ?? event);
      return;
    }
    const modelEvents = normalizeOpenAIRealtimeEvent(event, this.config.outputAudioFormat);
    const deliverableEvents: LiveModelEvent[] = [];
    for (const modelEvent of modelEvents) {
      if (modelEvent.type === "tool_call") {
        const fingerprint = `${modelEvent.call.name}\0${JSON.stringify(modelEvent.call.args)}`;
        const key = modelEvent.call.id ?? fingerprint;
        const handledFingerprint = this.handledToolCalls.get(key);
        if (handledFingerprint && handledFingerprint !== fingerprint) {
          this.handleProviderError(
            new Error("OpenAI Realtime reused a tool-call id for different tool data."),
          );
          return;
        }
        if (handledFingerprint) {
          continue;
        }
        if (this.handledToolCalls.size >= OPENAI_MAX_HANDLED_TOOL_CALLS) {
          const oldest = this.handledToolCalls.keys().next().value;
          if (oldest) this.handledToolCalls.delete(oldest);
        }
        this.handledToolCalls.set(key, fingerprint);
      }
      deliverableEvents.push(modelEvent);
    }
    if (deliverableEvents.filter((modelEvent) => modelEvent.type === "tool_call").length > 1) {
      this.handleProviderError(
        new Error("OpenAI Realtime returned multiple tool calls in one response; this session requires serialized tools."),
      );
      return;
    }
    this.trackResponseState(event, deliverableEvents.some((modelEvent) => modelEvent.type === "tool_call"));
    for (const modelEvent of deliverableEvents) {
      this.callbacks.onEvent(modelEvent);
    }
  }

  private sendJson(payload: unknown): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenAI Realtime WebSocket is not open.");
    }
    const serialized = JSON.stringify(payload);
    const payloadBytes = Buffer.byteLength(serialized, "utf8");
    if (this.ws.bufferedAmount + payloadBytes > OPENAI_MAX_BUFFERED_BYTES) {
      this.ws.terminate();
      throw new Error("OpenAI Realtime WebSocket exceeded the safe outbound buffer limit.");
    }
    this.ws.send(serialized);
  }

  private trackResponseState(event: any, deferQueuedResponse = false): void {
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
      this.responsePending = false;
      this.responseActive = false;
      this.cancellationPending = false;
      this.clearCancelAckTimeout();
      if (!deferQueuedResponse) this.flushQueuedResponse();
    }
  }

  private requestResponse(): void {
    if (this.responsePending || this.responseActive || this.cancellationPending) {
      this.responseCreateQueued = true;
      return;
    }
    this.responseCreateQueued = false;
    this.createResponse();
  }

  private handleProviderError(error: unknown, closeBeforeReady = false): void {
    this.callbacks.onError?.(error);
    if (!this.ready && !closeBeforeReady) return;
    this.responsePending = false;
    this.responseActive = false;
    this.responseCreateQueued = false;
    this.cancellationPending = false;
    this.clearCancelAckTimeout();
    closeWebSocket(this.ws, 1011, "OpenAI Realtime provider error");
  }

  private flushQueuedResponse(): void {
    if (
      !this.responseCreateQueued ||
      this.responsePending ||
      this.responseActive ||
      this.cancellationPending
    ) {
      return;
    }
    this.responseCreateQueued = false;
    try {
      this.createResponse();
    } catch (error) {
      this.callbacks.onError?.(error);
    }
  }

  private createResponse(): void {
    this.responsePending = true;
    try {
      this.sendJson({ type: "response.create" });
    } catch (error) {
      this.responsePending = false;
      throw error;
    }
  }

  private beginCancellation(): void {
    this.cancellationPending = true;
    this.cancelAckTimeout = setTimeout(() => {
      this.cancelAckTimeout = undefined;
      if (!this.cancellationPending) return;
      const error = new Error(
        `OpenAI Realtime did not confirm response cancellation within ${OPENAI_CANCEL_ACK_TIMEOUT_MS}ms.`,
      );
      this.callbacks.onError?.(error);
      closeWebSocket(this.ws, 1011, "OpenAI Realtime cancel timeout");
    }, OPENAI_CANCEL_ACK_TIMEOUT_MS);
    this.cancelAckTimeout.unref?.();
    try {
      this.sendJson(buildOpenAIResponseCancel());
    } catch (error) {
      this.cancellationPending = false;
      this.clearCancelAckTimeout();
      throw error;
    }
  }

  private clearCancelAckTimeout(): void {
    if (this.cancelAckTimeout) {
      clearTimeout(this.cancelAckTimeout);
      this.cancelAckTimeout = undefined;
    }
  }
}

function closeWebSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.close(code, reason);
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.terminate();
  }
}

export function normalizeOpenAIRealtimeEvent(
  event: unknown,
  outputAudioFormat: AppConfig["openai"]["outputAudioFormat"] = "pcm16",
): LiveModelEvent[] {
  const events: LiveModelEvent[] = [];
  const root = event as any;
  const calls = extractOpenAIFunctionCalls(root);

  const response = normalizeOpenAIResponseLifecycle(root);
  const deferTerminalResponse = calls.length > 0 && response?.status !== "started";
  if (response && !deferTerminalResponse) events.push(response);

  if ((root?.type === "response.output_audio.delta" || root?.type === "response.audio.delta") && typeof root.delta === "string") {
    events.push({ type: "audio", audio: { data: root.delta, mimeType: openAiAudioMimeType(outputAudioFormat) } });
    const audio = events[events.length - 1];
    if (audio?.type === "audio") {
      if (typeof root.item_id === "string") {
        audio.audio.itemId = root.item_id;
      }
      if (typeof root.content_index === "number") {
        audio.audio.contentIndex = root.content_index;
      }
    }
  }
  if (
    (root?.type === "response.output_text.delta" ||
      root?.type === "response.output_audio_transcript.delta" ||
      root?.type === "response.audio_transcript.delta") &&
    typeof root.delta === "string"
  ) {
    events.push({ type: "text", text: root.delta });
  }
  if (root?.type === "input_audio_buffer.speech_started") {
    events.push({
      type: "input_speech_started",
      provider: "openai",
      ...(typeof root.item_id === "string" ? { itemId: root.item_id } : {}),
      ...(typeof root.audio_start_ms === "number" ? { audioStartMs: root.audio_start_ms } : {}),
    });
  }
  for (const call of calls) {
    events.push({ type: "tool_call", call });
  }
  if (response && deferTerminalResponse) events.push(response);
  return events;
}

function normalizeOpenAIResponseLifecycle(
  root: any,
): Extract<LiveModelEvent, { type: "response" }> | undefined {
  const responseId = typeof root?.response?.id === "string"
    ? root.response.id
    : typeof root?.response_id === "string"
      ? root.response_id
      : undefined;
  if (root?.type === "response.created") {
    return { type: "response", status: "started", ...(responseId ? { responseId } : {}) };
  }
  const providerStatus = root?.response?.status;
  if (root?.type === "response.cancelled" || providerStatus === "cancelled") {
    return { type: "response", status: "cancelled", ...(responseId ? { responseId } : {}) };
  }
  if (
    root?.type === "response.failed" ||
    providerStatus === "failed" ||
    providerStatus === "incomplete"
  ) {
    return {
      type: "response",
      status: "failed",
      ...(responseId ? { responseId } : {}),
      error: "OpenAI Realtime response failed.",
    };
  }
  if (root?.type === "response.done" || providerStatus === "completed") {
    return { type: "response", status: "completed", ...(responseId ? { responseId } : {}) };
  }
  return undefined;
}

export function buildOpenAIRealtimeAudioAppend(
  audio: LiveModelAudio,
  inputFormat: AppConfig["openai"]["inputAudioFormat"] = "pcm16",
): { type: "input_audio_buffer.append"; audio: string } {
  if (inputFormat === "pcm16") {
    return { type: "input_audio_buffer.append", audio: normalizePcm16Audio(audio, OPENAI_REALTIME_PCM_INPUT_SAMPLE_RATE).data };
  }
  const actual = audio.mimeType.split(";")[0]?.trim().toLowerCase();
  const expected = inputFormat === "g711_ulaw" ? "audio/pcmu" : "audio/pcma";
  if (actual !== expected) {
    throw new Error(`OpenAI Realtime input format ${inputFormat} expects ${expected} audio.`);
  }
  return { type: "input_audio_buffer.append", audio: audio.data };
}

export function buildOpenAIResponseCancel(): { type: "response.cancel" } {
  return { type: "response.cancel" };
}

export function buildOpenAIConversationItemTruncate(truncate: RealtimeResponseTruncation): {
  type: "conversation.item.truncate";
  item_id: string;
  content_index: number;
  audio_end_ms: number;
} {
  return {
    type: "conversation.item.truncate",
    item_id: truncate.itemId,
    content_index: truncate.contentIndex,
    audio_end_ms: Math.max(0, Math.round(truncate.audioEndMs)),
  };
}

export function buildOpenAISessionUpdate(
  config: AppConfig["openai"],
  systemInstruction: string,
): { type: "session.update"; session: Record<string, unknown> } {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      model: config.model,
      instructions: systemInstruction,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: openAiSessionAudioFormat(config.inputAudioFormat, "input"),
          turn_detection: openAiTurnDetection(config.turnDetection),
        },
        output: {
          format: openAiSessionAudioFormat(config.outputAudioFormat, "output"),
          voice: config.voice,
        },
      },
      ...(isOpenAIReasoningRealtimeModel(config.model)
        ? { reasoning: { effort: config.reasoningEffort }, parallel_tool_calls: false }
        : {}),
      tools: OPENAI_HERMES_LIVE_TOOLS,
      tool_choice: "auto",
    },
  };
}

function isOpenAIReasoningRealtimeModel(model: string): boolean {
  return model.startsWith("gpt-realtime-2");
}

function parseOpenAIEvent(raw: WebSocket.RawData): any | undefined {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}

function extractOpenAIFunctionCalls(root: any): LiveToolCall[] {
  const calls: LiveToolCall[] = [];
  if (root?.type === "response.function_call_arguments.done") {
    calls.push({ id: root.call_id, name: String(root.name ?? ""), args: normalizeArgs(root.arguments ?? {}) });
  }
  const outputItems = [...(Array.isArray(root?.response?.output) ? root.response.output : []), root?.item].filter(Boolean);
  for (const item of outputItems) {
    if (item.type === "function_call") {
      calls.push({ id: item.call_id, name: String(item.name ?? ""), args: normalizeArgs(item.arguments ?? {}) });
    }
  }
  return calls.filter((call) => call.name.length > 0);
}

function normalizeArgs(value: unknown): Record<string, unknown> {
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

function buildRealtimeUrl(baseUrl: string, model: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("model", model);
  return url.toString();
}

function openAiAudioMimeType(format: AppConfig["openai"]["outputAudioFormat"]): string {
  if (format === "pcm16") {
    return "audio/pcm;rate=24000";
  }
  return format === "g711_ulaw" ? "audio/pcmu;rate=8000" : "audio/pcma;rate=8000";
}

function openAiTurnDetection(turnDetection: AppConfig["openai"]["turnDetection"]): null | { type: "semantic_vad" | "server_vad" } {
  if (turnDetection === "disabled") {
    return null;
  }
  return { type: turnDetection };
}

function openAiSessionAudioFormat(
  format: AppConfig["openai"]["inputAudioFormat"] | AppConfig["openai"]["outputAudioFormat"],
  direction: "input" | "output",
): { type: string; rate?: number } {
  if (format === "pcm16") {
    return direction === "input" ? { type: "audio/pcm", rate: 24000 } : { type: "audio/pcm" };
  }
  return format === "g711_ulaw" ? { type: "audio/pcmu" } : { type: "audio/pcma" };
}
