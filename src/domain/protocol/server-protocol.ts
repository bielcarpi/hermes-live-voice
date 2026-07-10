import type { ApprovalChoice } from "./client-protocol.js";

export type ServerMessage =
  | {
      type: "session.ready";
      sessionId: string;
      model: string;
      agent: { model?: string; capabilities?: Record<string, unknown> };
    }
  | { type: "session.error"; code: string; message: string; requestId?: string; recoverable?: boolean }
  | { type: "audio.output"; data: string; mimeType: string; itemId?: string; contentIndex?: number }
  | { type: "transcript.delta"; speaker: "user" | "assistant" | "system"; text: string; final?: boolean }
  | { type: "input.speech_started"; provider: "openai" | "local"; itemId?: string; audioStartMs?: number }
  | { type: "input.speech_stopped"; provider: "openai" | "local"; durationS?: number; audioEndMs?: number }
  | { type: "realtime.message"; message: unknown }
  | { type: "run.started"; runId: string; sessionId: string }
  | { type: "run.event"; runId: string; event: HermesRunEvent }
  | { type: "approval.request"; runId: string; event: HermesRunEvent }
  | { type: "approval.responded"; runId: string; choice: ApprovalChoice; resolved?: number }
  | { type: "run.completed"; runId: string; output: string; usage?: Record<string, unknown> }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.stopped"; runId: string; status: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; data?: unknown };

export interface HermesRunEvent {
  event?: string;
  run_id?: string;
  timestamp?: number;
  delta?: string;
  output?: string;
  error?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export function serverMessage(value: ServerMessage): string {
  return JSON.stringify(value);
}
