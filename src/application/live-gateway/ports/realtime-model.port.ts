import type { RealtimeResponseTruncation } from "../../../domain/protocol/client-protocol.js";

export interface LiveToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveModelAudio {
  data: string;
  mimeType: string;
  itemId?: string;
  contentIndex?: number;
}

export type LiveModelEvent =
  | { type: "audio"; audio: LiveModelAudio }
  | { type: "text"; text: string }
  | { type: "tool_call"; call: LiveToolCall }
  | { type: "input_speech_started"; provider: "openai" | "local"; itemId?: string; audioStartMs?: number }
  | { type: "input_speech_stopped"; provider: "openai" | "local"; durationS?: number; audioEndMs?: number }
  | { type: "raw"; message: unknown };

export interface LiveModelCallbacks {
  onEvent(event: LiveModelEvent): void;
  onOpen?(): void;
  onClose?(event?: unknown): void;
  onError?(error: unknown): void;
}

export interface LiveModelSession {
  sendRealtimeAudio(audio: LiveModelAudio): Promise<void>;
  sendText(text: string): Promise<void>;
  sendAudioStreamEnd(): Promise<void>;
  cancelResponse(reason?: string, truncate?: RealtimeResponseTruncation): Promise<boolean>;
  sendToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void>;
  sendNarration(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface LiveModelConnectParams {
  sessionId: string;
  systemInstruction: string;
  safetyIdentifier?: string;
  callbacks: LiveModelCallbacks;
}

export interface LiveModelAdapter {
  connect(params: LiveModelConnectParams): Promise<LiveModelSession>;
}
