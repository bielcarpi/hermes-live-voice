import type { AppConfig } from "../../../config.js";
import type { ApprovalChoice } from "../../../domain/protocol/client-protocol.js";
import type { HermesRunEvent } from "../../../domain/protocol/server-protocol.js";
import type {
  ApprovalResult,
  HermesCapabilities,
  HermesRequestOptions,
  HermesRunsPort,
  StartRunParams,
  StartRunResult,
} from "../../../application/live-gateway/ports/hermes-runs.port.js";
import { parseSseStream } from "./sse.js";

export const MAX_HERMES_JSON_RESPONSE_BYTES = 1_000_000;
const MAX_HERMES_ERROR_DETAIL_CHARS = 2_000;

export class HermesClient implements HermesRunsPort {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(config: AppConfig["hermes"]) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
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
      headers: this.sessionHeaders(params.sessionKey),
      ...signalInit(signal),
    });
    if (response?.run_id !== undefined && !isBoundedHermesIdentifier(response.run_id)) {
      throw new Error("Hermes returned an invalid run_id.");
    }
    if (response?.runId !== undefined && !isBoundedHermesIdentifier(response.runId)) {
      throw new Error("Hermes returned an invalid runId alias.");
    }
    if (response?.run_id !== undefined && response.runId !== undefined && response.run_id !== response.runId) {
      throw new Error("Hermes returned conflicting run identifiers.");
    }
    const runId = response?.run_id ?? response?.runId;
    if (!isBoundedHermesIdentifier(runId)) {
      throw new Error("Hermes did not return a valid bounded run_id.");
    }
    return {
      runId,
      status: typeof response.status === "string" && response.status.length <= 128
        ? response.status
        : "started",
    };
  }

  async getRun(runId: string, options?: AbortSignal | HermesRequestOptions): Promise<Record<string, unknown>> {
    const requestOptions = normalizeHermesRequestOptions(options);
    return this.requestJson<Record<string, unknown>>(`/v1/runs/${encodeURIComponent(runId)}`, {
      method: "GET",
      headers: this.sessionHeaders(requestOptions.sessionKey),
      ...signalInit(requestOptions.signal),
    });
  }

  async stopRun(runId: string, options?: AbortSignal | HermesRequestOptions): Promise<{ run_id?: string; status?: string }> {
    const requestOptions = normalizeHermesRequestOptions(options);
    return this.requestJson<{ run_id?: string; status?: string }>(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      body: "{}",
      headers: this.sessionHeaders(requestOptions.sessionKey),
      ...signalInit(requestOptions.signal),
    });
  }

  async submitApproval(
    runId: string,
    choice: ApprovalChoice,
    options: { resolveAll?: boolean; signal?: AbortSignal; sessionKey?: string } = {},
  ): Promise<ApprovalResult> {
    return this.requestJson<ApprovalResult>(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      body: JSON.stringify({ choice, resolve_all: options.resolveAll ?? false }),
      headers: this.sessionHeaders(options.sessionKey),
      ...signalInit(options.signal),
    });
  }

  async *streamRunEvents(runId: string, options?: AbortSignal | HermesRequestOptions): AsyncGenerator<HermesRunEvent> {
    const requestOptions = normalizeHermesRequestOptions(options);
    const path = `/v1/runs/${encodeURIComponent(runId)}/events`;
    const requestSignal = createRequestSignal(
      requestOptions.signal,
      this.timeoutMs,
      `Hermes events request timed out after ${this.timeoutMs}ms: ${path}`,
    );
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.headers({ accept: "text/event-stream", ...this.sessionHeaders(requestOptions.sessionKey) }),
        signal: requestSignal.signal,
      });
      if (!response.ok) {
        const detail = await readBoundedResponseText(response, MAX_HERMES_JSON_RESPONSE_BYTES);
        throw new Error(
          `Hermes events request failed: ${response.status} ${detail.slice(0, MAX_HERMES_ERROR_DETAIL_CHARS)}`.trim(),
        );
      }
      if (!response.body) {
        throw new Error("Hermes events response did not include a body.");
      }
      requestSignal.clearTimeout();
      yield* parseSseStream(response.body);
    } catch (error) {
      throw requestSignal.timedOut() ? new Error(`Hermes events request timed out after ${this.timeoutMs}ms: ${path}`) : error;
    } finally {
      requestSignal.cleanup();
    }
  }

  private async requestJson<T>(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<T> {
    const requestSignal = createRequestSignal(init.signal ?? undefined, this.timeoutMs, `Hermes request timed out after ${this.timeoutMs}ms: ${path}`);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: requestSignal.signal,
        headers: this.headers(init.headers),
      });
      if (!response.ok) {
        const detail = await readBoundedResponseText(response, MAX_HERMES_JSON_RESPONSE_BYTES);
        throw new Error(
          `Hermes request failed: ${response.status} ${detail.slice(0, MAX_HERMES_ERROR_DETAIL_CHARS)}`.trim(),
        );
      }
      const body = await readBoundedResponseText(response, MAX_HERMES_JSON_RESPONSE_BYTES);
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new Error(`Hermes returned invalid JSON for ${path}.`);
      }
    } catch (error) {
      throw requestSignal.timedOut() ? new Error(`Hermes request timed out after ${this.timeoutMs}ms: ${path}`) : error;
    } finally {
      requestSignal.cleanup();
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    };
  }

  private sessionHeaders(sessionKey: string | undefined): Record<string, string> {
    return this.apiKey && sessionKey ? { "X-Hermes-Session-Key": sessionKey } : {};
  }
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Hermes response exceeded the ${maximumBytes}-byte safety limit.`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let reachedEof = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        throw new Error(`Hermes response exceeded the ${maximumBytes}-byte safety limit.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (!reachedEof) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function normalizeHermesRequestOptions(options: AbortSignal | HermesRequestOptions | undefined): HermesRequestOptions {
  if (!options) {
    return {};
  }
  return "aborted" in options && "addEventListener" in options ? { signal: options } : options;
}

function isBoundedHermesIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function signalInit(signal: AbortSignal | undefined): Pick<RequestInit, "signal"> {
  return signal ? { signal } : {};
}

function withSignal<T extends RequestInit>(init: T, signal: AbortSignal | undefined): T & Pick<RequestInit, "signal"> {
  return { ...init, ...signalInit(signal) };
}

function createRequestSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
): {
  signal: AbortSignal;
  timedOut(): boolean;
  clearTimeout(): void;
  cleanup(): void;
} {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const onParentAbort = () => {
    controller.abort(parentSignal?.reason ?? new Error("Hermes request aborted."));
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(timeoutMessage));
    }, timeoutMs);
  }

  const clearRequestTimeout = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clearTimeout: clearRequestTimeout,
    cleanup: () => {
      clearRequestTimeout();
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}
