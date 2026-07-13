import { GoogleGenAI, Modality } from "@google/genai";
import { GEMINI_LIVE_INPUT_SAMPLE_RATE, normalizePcm16Audio } from "../../../domain/audio/pcm.js";
import type { AppConfig } from "../../../config.js";
import { HERMES_LIVE_TOOL_DECLARATIONS } from "../../../application/live-gateway/tool-definitions.js";
import type {
  LiveModelAdapter,
  LiveModelAudio,
  LiveModelConnectParams,
  LiveModelEvent,
  LiveModelSession,
  LiveToolCall,
} from "../../../application/live-gateway/ports/realtime-model.port.js";

export class GeminiLiveAdapter implements LiveModelAdapter {
  constructor(private readonly config: AppConfig["gemini"]) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    this.assertConfigured();
    const ai = this.createClient();
    const forwardMessage = createGeminiLiveEventForwarder(params.callbacks.onEvent);
    const session: any = await (ai as any).live.connect({
      model: this.config.model,
      config: buildGeminiLiveConnectConfig(params.systemInstruction),
      callbacks: {
        onopen: () => params.callbacks.onOpen?.(),
        onclose: (event: unknown) => params.callbacks.onClose?.(event),
        onerror: (event: unknown) => params.callbacks.onError?.(event),
        onmessage: forwardMessage,
      },
    });
    return new GeminiLiveSession(session);
  }

  private assertConfigured(): void {
    if (this.config.enterprise && !this.config.project) {
      throw new Error("GOOGLE_CLOUD_PROJECT is required when GOOGLE_GENAI_USE_ENTERPRISE=true.");
    }
    if (!this.config.enterprise && !this.config.apiKey) {
      throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required when HERMES_LIVE_PROVIDER=gemini.");
    }
  }

  private createClient(): GoogleGenAI {
    if (this.config.enterprise) {
      return new GoogleGenAI({
        enterprise: true,
        project: this.config.project,
        location: this.config.location,
        ...(this.config.apiVersion ? { apiVersion: this.config.apiVersion } : {}),
      } as any);
    }
    return new GoogleGenAI({
      apiKey: this.config.apiKey,
      ...(this.config.apiVersion ? { apiVersion: this.config.apiVersion } : {}),
    } as any);
  }
}

export function createGeminiLiveEventForwarder(onEvent: (event: LiveModelEvent) => void) {
  let responseActive = false;
  return (message: unknown): void => {
    for (const event of normalizeGeminiLiveMessage(message)) {
      const startsAssistantResponse = event.type === "audio" ||
        (event.type === "text" && (event.speaker ?? "assistant") === "assistant");
      if (startsAssistantResponse && !responseActive) {
        responseActive = true;
        onEvent({ type: "response", status: "started" });
      }
      onEvent(event);
      if (event.type === "response" && event.status !== "started") responseActive = false;
    }
  };
}

export function buildGeminiLiveConnectConfig(systemInstruction: string) {
  return {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction,
    tools: [{ functionDeclarations: HERMES_LIVE_TOOL_DECLARATIONS }],
  };
}

export class GeminiLiveSession implements LiveModelSession {
  constructor(private readonly session: any) {}

  async sendRealtimeAudio(audio: LiveModelAudio): Promise<void> {
    await this.session.sendRealtimeInput(buildGeminiRealtimeAudioInput(audio));
  }

  async sendText(text: string): Promise<void> {
    if (typeof this.session.sendRealtimeInput === "function") {
      await this.session.sendRealtimeInput(buildGeminiRealtimeTextInput(text));
      return;
    }
    if (typeof this.session.sendClientContent === "function") {
      await this.session.sendClientContent(buildGeminiTextTurn(text));
      return;
    }
    throw new Error("Gemini Live session does not support realtime text input.");
  }

  async sendAudioStreamEnd(): Promise<void> {
    await this.session.sendRealtimeInput({ audioStreamEnd: true });
  }

  async cancelResponse(): Promise<boolean> {
    // Gemini Live handles barge-in through live audio activity. The SDK does not
    // currently expose a direct response-cancel event.
    return false;
  }

  async sendToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    await this.session.sendToolResponse(buildGeminiToolResponse(call, response));
  }

  async close(): Promise<void> {
    if (typeof this.session.close === "function") {
      this.session.close();
    }
  }
}

export function buildGeminiRealtimeAudioInput(audio: LiveModelAudio): { audio: { data: string; mimeType: string } } {
  const normalized = normalizePcm16Audio(audio, GEMINI_LIVE_INPUT_SAMPLE_RATE);
  return { audio: { data: normalized.data, mimeType: normalized.mimeType } };
}

export function buildGeminiRealtimeTextInput(text: string): { text: string } {
  return { text };
}

export function buildGeminiTextTurn(text: string): { turns: Array<{ role: "user"; parts: Array<{ text: string }> }>; turnComplete: true } {
  return {
    turns: [{ role: "user", parts: [{ text }] }],
    turnComplete: true,
  };
}

export function buildGeminiToolResponse(
  call: LiveToolCall,
  response: Record<string, unknown>,
): { functionResponses: Array<{ id: string; name: string; response: Record<string, unknown> }> } {
  if (!call.id) {
    throw new Error(`Gemini Live function call ${call.name} did not include an id.`);
  }
  return { functionResponses: [{ id: call.id, name: call.name, response }] };
}

export function normalizeGeminiLiveMessage(message: unknown): LiveModelEvent[] {
  const events: LiveModelEvent[] = [];
  const root = unwrapMessage(message);
  const serverContent = root?.serverContent ?? root?.server_content;

  const inputTranscription = extractTranscription(serverContent, "inputTranscription", "input_transcription");
  const interimInputTranscription = extractTranscription(
    serverContent,
    "interimInputTranscription",
    "interim_input_transcription",
  );
  const outputTranscription = extractTranscription(serverContent, "outputTranscription", "output_transcription");

  // A finalized/standard input transcript supersedes a low-latency interim
  // transcript when Gemini includes both in one server message. Fall back to
  // the interim value if the standard field is present but has no text yet.
  const userTranscriptEvent =
    normalizeTranscription(inputTranscription, "user") ??
    normalizeTranscription(interimInputTranscription, "user", false);
  if (userTranscriptEvent) events.push(userTranscriptEvent);

  const assistantTranscriptEvent = normalizeTranscription(outputTranscription, "assistant");
  if (assistantTranscriptEvent) events.push(assistantTranscriptEvent);

  for (const call of extractFunctionCalls(root)) {
    events.push({ type: "tool_call", call });
  }
  const data = root?.data;
  if (typeof data === "string") {
    events.push({
      type: "audio",
      audio: { data, mimeType: root.mimeType ?? root.mime_type ?? "audio/pcm;rate=24000" },
    });
  }
  for (const part of extractParts(root)) {
    const text = typeof part.text === "string" ? part.text : undefined;
    // Native-audio responses may expose the same spoken content as both a
    // model text part and outputTranscription. Prefer the transcript because
    // it carries Gemini's completion signal.
    if (text && !assistantTranscriptEvent) {
      events.push({ type: "text", text });
    }
    const inlineData = part.inlineData ?? part.inline_data;
    const data = inlineData?.data;
    if (typeof data === "string") {
      events.push({
        type: "audio",
        audio: { data, mimeType: inlineData.mimeType ?? inlineData.mime_type ?? "audio/pcm;rate=24000" },
      });
    }
  }
  if (serverContent?.interrupted === true) {
    events.push({ type: "response", status: "cancelled" });
  } else if (serverContent?.turnComplete === true || serverContent?.turn_complete === true) {
    events.push({ type: "response", status: "completed" });
  }
  return events;
}

function extractTranscription(serverContent: any, camelCaseKey: string, snakeCaseKey: string): any {
  return serverContent?.[camelCaseKey] ?? serverContent?.[snakeCaseKey];
}

function normalizeTranscription(
  transcription: any,
  speaker: "user" | "assistant",
  finalOverride?: boolean,
): Extract<LiveModelEvent, { type: "text" }> | undefined {
  const text = transcription?.text;
  if (typeof text !== "string" || text.length === 0) {
    return undefined;
  }
  const finished = transcription?.finished ?? transcription?.is_finished;
  const final = finalOverride ?? (typeof finished === "boolean" ? finished : undefined);
  return {
    type: "text",
    speaker,
    text,
    ...(final === undefined ? {} : { final }),
  };
}

function unwrapMessage(message: unknown): any {
  if (message && typeof message === "object" && "data" in message) {
    const data = (message as { data: unknown }).data;
    if (data && typeof data === "object") {
      return data;
    }
  }
  return message;
}

function extractFunctionCalls(root: any): LiveToolCall[] {
  const candidates = [
    root?.toolCall?.functionCalls,
    root?.tool_call?.function_calls,
    root?.functionCalls,
    root?.function_calls,
    root?.serverContent?.modelTurn?.parts?.map((part: any) => part.functionCall ?? part.function_call),
  ];
  return candidates
    .flat()
    .filter(Boolean)
    .map((call: any) => ({
      id: call.id ?? call.callId ?? call.call_id,
      name: String(call.name ?? ""),
      args: normalizeArgs(call.args ?? call.arguments ?? {}),
    }))
    .filter((call: LiveToolCall) => call.name.length > 0);
}

function extractParts(root: any): any[] {
  return [
    root?.serverContent?.modelTurn?.parts,
    root?.server_content?.model_turn?.parts,
    root?.modelTurn?.parts,
    root?.content?.parts,
    root?.parts,
  ]
    .flat()
    .filter(Boolean);
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
