import type { ApprovalChoice } from "../../../domain/protocol/client-protocol.js";
import type { HermesRunEvent } from "../../../domain/protocol/server-protocol.js";

export interface HermesCapabilities {
  object?: string;
  platform?: string;
  model?: string;
  auth?: Record<string, unknown>;
  features?: Record<string, unknown>;
  endpoints?: Record<string, { method?: string; path?: string }>;
  [key: string]: unknown;
}

export interface StartRunParams {
  input: string;
  sessionId: string;
  sessionKey: string;
  instructions?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

export interface StartRunResult {
  runId: string;
  status: string;
}

export interface HermesSessionSummary {
  id: string;
  source?: string;
  model?: string;
  title?: string;
  preview?: string;
  startedAt?: number;
  endedAt?: number;
  lastActive?: number;
  messageCount?: number;
  parentSessionId?: string;
}

export interface HermesSessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface HermesSessionHistory {
  /** Hermes resolves compression lineage and returns the current writable tip. */
  sessionId: string;
  messages: HermesSessionMessage[];
}

export interface ListHermesSessionsOptions {
  limit?: number;
  offset?: number;
  source?: string;
  signal?: AbortSignal;
}

export interface CreateHermesSessionOptions {
  title?: string;
  signal?: AbortSignal;
}

export interface HermesSessionChatResult {
  sessionId: string;
  content: string;
  usage?: HermesRunUsage;
}

export type HermesRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled";

export interface HermesRunUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface HermesRunSnapshotBase {
  object: "hermes.run";
  run_id: string;
  status: HermesRunStatus;
  session_id?: string;
  model?: string;
  created_at?: number;
  updated_at?: number;
  last_event?: string;
  [key: string]: unknown;
}

export interface HermesRunActiveSnapshot extends HermesRunSnapshotBase {
  status: "queued" | "running" | "waiting_for_approval" | "stopping";
}

export interface HermesRunCompletedSnapshot extends HermesRunSnapshotBase {
  status: "completed";
  output: string;
  usage: HermesRunUsage;
}

export interface HermesRunFailedSnapshot extends HermesRunSnapshotBase {
  status: "failed";
  error: string;
}

export interface HermesRunCancelledSnapshot extends HermesRunSnapshotBase {
  status: "cancelled";
}

export type HermesRunSnapshot =
  | HermesRunActiveSnapshot
  | HermesRunCompletedSnapshot
  | HermesRunFailedSnapshot
  | HermesRunCancelledSnapshot;

export interface HermesRequestOptions {
  signal?: AbortSignal;
  sessionKey?: string;
}

export interface ApprovalResult {
  object?: string;
  run_id?: string;
  runId?: string;
  approval_id?: string;
  approvalId?: string;
  choice?: ApprovalChoice;
  resolved?: number;
}

export interface HermesRunsPort {
  readonly baseUrl?: string;

  health(signal?: AbortSignal): Promise<Record<string, unknown>>;
  capabilities(signal?: AbortSignal): Promise<HermesCapabilities>;
  assertRunsSupported(signal?: AbortSignal): Promise<HermesCapabilities>;
  assertSessionsSupported?(signal?: AbortSignal): Promise<HermesCapabilities>;
  listSessions?(options?: ListHermesSessionsOptions): Promise<HermesSessionSummary[]>;
  createSession?(options?: CreateHermesSessionOptions): Promise<HermesSessionSummary>;
  getSession?(sessionId: string, signal?: AbortSignal): Promise<HermesSessionSummary>;
  getSessionHistory?(sessionId: string, signal?: AbortSignal): Promise<HermesSessionHistory>;
  chatSession?(
    sessionId: string,
    message: string,
    options?: { signal?: AbortSignal; sessionKey?: string; instructions?: string },
  ): Promise<HermesSessionChatResult>;
  startRun(params: StartRunParams, signal?: AbortSignal): Promise<StartRunResult>;
  getRun(runId: string, options?: AbortSignal | HermesRequestOptions): Promise<HermesRunSnapshot>;
  stopRun(runId: string, options?: AbortSignal | HermesRequestOptions): Promise<{ run_id: string; status: "stopping" }>;
  submitApproval(
    runId: string,
    choice: ApprovalChoice,
    options?: { approvalId?: string; resolveAll?: boolean; signal?: AbortSignal; sessionKey?: string },
  ): Promise<ApprovalResult>;
  streamRunEvents(runId: string, options?: AbortSignal | HermesRequestOptions): AsyncGenerator<HermesRunEvent>;
}
