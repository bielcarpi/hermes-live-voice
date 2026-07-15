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
