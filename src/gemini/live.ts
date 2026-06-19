import { GoogleGenAI, Modality } from "@google/genai";
import { GEMINI_LIVE_INPUT_SAMPLE_RATE, normalizePcm16Audio } from "../audio/pcm.js";
import type { AppConfig } from "../config.js";
import { HERMES_LIVE_TOOL_DECLARATIONS, type LiveModelAudio, type LiveModelEvent, type LiveToolCall } from "../protocol.js";
import type { LiveModelAdapter, LiveModelConnectParams, LiveModelSession } from "../realtime/live.js";

export class GeminiLiveAdapter implements LiveModelAdapter {
  constructor(private readonly config: AppConfig["gemini"]) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    const ai = this.createClient();
    const session: any = await (ai as any).live.connect({
      model: this.config.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: params.systemInstruction,
        tools: [{ functionDeclarations: HERMES_LIVE_TOOL_DECLARATIONS }],
      },
      callbacks: {
        onopen: () => params.callbacks.onOpen?.(),
        onclose: (event: unknown) => params.callbacks.onClose?.(event),
        onerror: (event: unknown) => params.callbacks.onError?.(event),
        onmessage: (message: unknown) => {
          for (const event of normalizeGeminiLiveMessage(message)) {
            params.callbacks.onEvent(event);
          }
        },
      },
    });
    return new GeminiLiveSession(session);
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

class GeminiLiveSession implements LiveModelSession {
  constructor(private readonly session: any) {}

  async sendRealtimeAudio(audio: LiveModelAudio): Promise<void> {
    await this.session.sendRealtimeInput(buildGeminiRealtimeAudioInput(audio));
  }

  async sendText(text: string): Promise<void> {
    if (typeof this.session.sendRealtimeInput === "function") {
      await this.session.sendRealtimeInput({ text });
      return;
    }
    await this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    });
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
    await this.session.sendToolResponse({
      functionResponses: [{ id: call.id, name: call.name, response }],
    });
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

export function normalizeGeminiLiveMessage(message: unknown): LiveModelEvent[] {
  const events: LiveModelEvent[] = [{ type: "raw", message }];
  const root = unwrapMessage(message);

  for (const call of extractFunctionCalls(root)) {
    events.push({ type: "tool_call", call });
  }
  for (const part of extractParts(root)) {
    const text = typeof part.text === "string" ? part.text : undefined;
    if (text) {
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
  return events;
}

function unwrapMessage(message: unknown): any {
  if (message && typeof message === "object" && "data" in message) {
    return (message as { data: unknown }).data;
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
