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
  getRun(runId: string, options?: AbortSignal | HermesRequestOptions): Promise<Record<string, unknown>>;
  stopRun(runId: string, options?: AbortSignal | HermesRequestOptions): Promise<{ run_id: string; status: "stopping" }>;
  submitApproval(
    runId: string,
    choice: ApprovalChoice,
    options?: { approvalId?: string; resolveAll?: boolean; signal?: AbortSignal; sessionKey?: string },
  ): Promise<ApprovalResult>;
  streamRunEvents(runId: string, options?: AbortSignal | HermesRequestOptions): AsyncGenerator<HermesRunEvent>;
}
