import type { AppConfig } from "../config.js";
import type { ApprovalChoice, HermesRunEvent } from "../protocol.js";
import { parseSseStream } from "./sse.js";

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

export interface ApprovalResult {
  object?: string;
  run_id?: string;
  runId?: string;
  choice?: ApprovalChoice;
  resolved?: number;
}

export class HermesClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor(config: AppConfig["hermes"]) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>("/health", withSignal({ method: "GET" }, signal));
  }

  async capabilities(signal?: AbortSignal): Promise<HermesCapabilities> {
    return this.requestJson<HermesCapabilities>("/v1/capabilities", withSignal({ method: "GET" }, signal));
  }

  async assertRunsSupported(signal?: AbortSignal): Promise<HermesCapabilities> {
    const capabilities = await this.capabilities(signal);
    const features = capabilities.features ?? {};
    const required = ["run_submission", "run_events_sse", "run_stop", "run_approval_response"];
    const missing = required.filter((name) => features[name] !== true);
    if (missing.length > 0) {
      throw new Error(`Hermes API Server is missing required features: ${missing.join(", ")}`);
    }
    return capabilities;
  }

  async startRun(params: StartRunParams, signal?: AbortSignal): Promise<StartRunResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: params.input,
      session_id: params.sessionId,
    };
    if (params.instructions) {
      body.instructions = params.instructions;
    }
    if (params.conversationHistory?.length) {
      body.conversation_history = params.conversationHistory;
    }
    const response = await this.requestJson<{ run_id?: string; runId?: string; status?: string }>("/v1/runs", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "X-Hermes-Session-Key": params.sessionKey },
      ...signalInit(signal),
    });
    const runId = response.run_id ?? response.runId;
    if (!runId) {
      throw new Error("Hermes did not return a run_id.");
    }
    return { runId, status: response.status ?? "started" };
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(`/v1/runs/${encodeURIComponent(runId)}`, {
      method: "GET",
      ...signalInit(signal),
    });
  }

  async stopRun(runId: string, signal?: AbortSignal): Promise<{ run_id?: string; status?: string }> {
    return this.requestJson<{ run_id?: string; status?: string }>(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      body: "{}",
      ...signalInit(signal),
    });
  }

  async submitApproval(
    runId: string,
    choice: ApprovalChoice,
    options: { resolveAll?: boolean; signal?: AbortSignal } = {},
  ): Promise<ApprovalResult> {
    return this.requestJson<ApprovalResult>(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      body: JSON.stringify({ choice, resolve_all: options.resolveAll ?? false }),
      ...signalInit(options.signal),
    });
  }

  async *streamRunEvents(runId: string, signal?: AbortSignal): AsyncGenerator<HermesRunEvent> {
    const response = await fetch(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
      headers: this.headers({ accept: "text/event-stream" }),
      ...signalInit(signal),
    });
    if (!response.ok) {
      throw new Error(`Hermes events request failed: ${response.status} ${await response.text()}`);
    }
    if (!response.body) {
      throw new Error("Hermes events response did not include a body.");
    }
    yield* parseSseStream(response.body);
  }

  private async requestJson<T>(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers),
    });
    if (!response.ok) {
      throw new Error(`Hermes request failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    };
  }
}

function signalInit(signal: AbortSignal | undefined): Pick<RequestInit, "signal"> {
  return signal ? { signal } : {};
}

function withSignal<T extends RequestInit>(init: T, signal: AbortSignal | undefined): T & Pick<RequestInit, "signal"> {
  return { ...init, ...signalInit(signal) };
}
