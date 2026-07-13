import type { ApprovalChoice } from "./client-protocol.js";
import type { HermesLiveProtocolVersion } from "./version.js";

export interface RealtimeClientCapabilities {
  provider: "gemini" | "openai" | "mock";
  model: string;
  audio: {
    input: { enabled: boolean; mimeType?: string; recommendedFrameMs?: number };
    output: { enabled: boolean; mimeType?: string };
    turnDetection: "disabled" | "semantic_vad" | "server_vad" | "provider" | "none";
  };
}

export interface HermesApprovalDetails {
  approvalId: string;
  command?: string;
  description?: string;
  patternKey?: string;
  patternKeys?: string[];
  choices: ApprovalChoice[];
  allowPermanent: boolean;
}

export type ServerMessage =
  | {
      type: "session.ready";
      protocolVersion: HermesLiveProtocolVersion;
      sessionId: string;
      model: string;
      hermes: { model?: string; capabilities?: Record<string, unknown> };
      realtime: RealtimeClientCapabilities;
    }
  | { type: "session.error"; code: string; message: string; requestId?: string; recoverable?: boolean }
  | { type: "audio.output"; data: string; mimeType: string; itemId?: string; contentIndex?: number }
  | { type: "transcript.delta"; speaker: "user" | "assistant" | "system"; text: string; final?: boolean }
  | { type: "input.speech_started"; provider: "openai"; itemId?: string; audioStartMs?: number }
  | { type: "response.started"; responseId?: string }
  | { type: "response.completed"; responseId?: string }
  | { type: "response.cancelled"; responseId?: string }
  | { type: "response.failed"; responseId?: string; error: string }
  | { type: "run.started"; runId: string; sessionId: string }
  | { type: "run.event"; runId: string; event: HermesRunEvent }
  | { type: "approval.request"; runId: string; event: HermesRunEvent; approval: HermesApprovalDetails }
  | {
      type: "approval.responded";
      requestId: string;
      runId: string;
      approvalId: string;
      choice: ApprovalChoice;
      resolved: 1;
    }
  | { type: "run.completed"; runId: string; output: string; usage?: Record<string, unknown> }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.stopping"; runId: string; status: string }
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
