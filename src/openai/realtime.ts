import WebSocket from "ws";
import { normalizePcm16Audio } from "../audio/pcm.js";
import type { AppConfig } from "../config.js";
import {
  OPENAI_HERMES_LIVE_TOOLS,
  type LiveModelAudio,
  type LiveModelEvent,
  type LiveToolCall,
  type RealtimeResponseTruncation,
} from "../protocol.js";
import type { LiveModelAdapter, LiveModelCallbacks, LiveModelConnectParams, LiveModelSession } from "../realtime/live.js";

const OPENAI_REALTIME_PCM_INPUT_SAMPLE_RATE = 24_000;

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
    const ws = new WebSocket(url, { headers });
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
        reject(error);
      };
      const onInitialClose = (code: number, reason: Buffer) => {
        cleanup();
        reject(new Error(`OpenAI Realtime WebSocket closed before session start: ${code} ${reason.toString("utf8")}`));
      };
      const onOpen = () => session.configure(params.systemInstruction);
      const onInitialMessage = (raw: WebSocket.RawData) => {
        const event = parseOpenAIEvent(raw);
        if (event?.type === "session.updated") {
          cleanup();
          params.callbacks.onOpen?.();
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

class OpenAIRealtimeSession implements LiveModelSession {
  private readonly handledToolCalls = new Set<string>();
  private responseActive = false;
  private responsePending = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly config: AppConfig["openai"],
    private readonly callbacks: LiveModelCallbacks,
  ) {
    this.ws.on("message", (raw) => this.handleMessage(raw));
    this.ws.on("close", (code, reason) => callbacks.onClose?.({ code, reason: reason.toString("utf8") }));
    this.ws.on("error", (error) => callbacks.onError?.(error));
  }

  configure(systemInstruction: string): void {
    this.sendJson(buildOpenAISessionUpdate(this.config, systemInstruction));
  }

  async sendRealtimeAudio(audio: LiveModelAudio): Promise<void> {
    this.sendJson(buildOpenAIRealtimeAudioAppend(audio, this.config.inputAudioFormat));
  }

  async sendText(text: string): Promise<void> {
    this.sendJson({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.createResponse();
  }

  async sendAudioStreamEnd(): Promise<void> {
    if (this.config.turnDetection !== "disabled") {
      return;
    }
    this.sendJson({ type: "input_audio_buffer.commit" });
    this.createResponse();
  }

  async cancelResponse(_reason?: string, truncate?: RealtimeResponseTruncation): Promise<boolean> {
    const shouldCancel = this.responsePending || this.responseActive;
    if (!shouldCancel && !truncate) {
      return false;
    }
    if (shouldCancel) {
      this.sendJson(buildOpenAIResponseCancel());
    }
    if (truncate) {
      this.sendJson(buildOpenAIConversationItemTruncate(truncate));
    }
    this.responsePending = false;
    this.responseActive = false;
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
    this.createResponse();
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, "session closed");
    }
  }

  private handleMessage(raw: WebSocket.RawData): void {
    const event = parseOpenAIEvent(raw);
    if (!event) {
      this.callbacks.onError?.(new Error("OpenAI Realtime event was not valid JSON."));
      return;
    }
    this.trackResponseState(event);
    if ((event as { type?: string }).type === "error") {
      this.callbacks.onError?.((event as { error?: unknown }).error ?? event);
    }
    for (const modelEvent of normalizeOpenAIRealtimeEvent(event, this.config.outputAudioFormat)) {
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
      throw new Error("OpenAI Realtime WebSocket is not open.");
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
      this.responsePending = false;
      this.responseActive = false;
    }
  }
}

export function normalizeOpenAIRealtimeEvent(
  event: unknown,
  outputAudioFormat: AppConfig["openai"]["outputAudioFormat"] = "pcm16",
): LiveModelEvent[] {
  const events: LiveModelEvent[] = [{ type: "raw", message: event }];
  const root = event as any;

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
  for (const call of extractOpenAIFunctionCalls(root)) {
    events.push({ type: "tool_call", call });
  }
  return events;
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
      ...(config.model.startsWith("gpt-realtime-2") ? { reasoning: { effort: config.reasoningEffort } } : {}),
      parallel_tool_calls: false,
      tools: OPENAI_HERMES_LIVE_TOOLS,
      tool_choice: "auto",
    },
  };
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
