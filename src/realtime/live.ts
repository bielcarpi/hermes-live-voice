import type { LiveModelAudio, LiveModelEvent, LiveToolCall, RealtimeResponseTruncation } from "../protocol.js";

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

export function buildSystemInstruction(): string {
  return [
    "You are the realtime voice interface for Hermes Agent.",
    "Keep spoken responses brief, natural, and interruptible.",
    "For quick conversational acknowledgement, answer directly.",
    "When the user asks for memory, files, terminal work, research, tools, code, repo inspection, current information, or any meaningful action, call start_hermes_run.",
    "Do not claim you used tools unless Hermes returned the result.",
    "If Hermes asks for approval, explain that a human approval is required and wait for the gateway/user interface.",
    "If the user interrupts, stop speaking immediately. If a Hermes run is active and the user wants cancellation, call stop_hermes_run.",
    "Never ask the user for Hermes API keys, realtime provider API keys, or trusted session identifiers.",
  ].join("\n");
}
