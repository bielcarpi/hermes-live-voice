import { DEFAULT_HERMES_STREAM_IDLE_TIMEOUT_MS, type AppConfig } from "../../../config.js";
import type { ApprovalChoice } from "../../../domain/protocol/client-protocol.js";
import type { HermesRunEvent } from "../../../domain/protocol/server-protocol.js";
import type {
  ApprovalResult,
  HermesCapabilities,
  HermesRequestOptions,
  HermesRunSnapshot,
  HermesRunSnapshotBase,
  HermesRunStatus,
  HermesRunUsage,
  HermesRunsPort,
  StartRunParams,
  StartRunResult,
} from "../../../application/live-gateway/ports/hermes-runs.port.js";
import { parseSseStream } from "./sse.js";

export const MAX_HERMES_JSON_RESPONSE_BYTES = 1_000_000;
export const MAX_HERMES_RUN_OUTPUT_CHARS = 200_000;
export const MAX_HERMES_RETRY_AFTER_CHARS = 128;
const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;
const MAX_HERMES_RETRY_AFTER_SECONDS = 86_400;
const MAX_HERMES_RUN_METADATA_CHARS = 512;
const HERMES_RUN_STATUSES = new Set<HermesRunStatus>([
  "queued",
  "running",
  "waiting_for_approval",
  "stopping",
  "completed",
  "failed",
  "cancelled",
]);

export class HermesRequestError extends Error {
  override readonly name = "HermesRequestError";
  readonly retryAfter?: string;
  readonly errorCode?: string;

  constructor(
    readonly status: number,
    readonly publicPath: string,
    retryAfter?: string,
    messagePrefix = "Hermes request failed",
    errorCode?: string,
  ) {
    super(`${messagePrefix}: ${status} ${publicPath}`);
    this.retryAfter = boundedRetryAfterValue(retryAfter);
    this.errorCode = boundedHermesErrorCode(errorCode);
  }
}

export class HermesClient implements HermesRunsPort {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly streamIdleTimeoutMs: number;

  constructor(config: AppConfig["hermes"]) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.streamIdleTimeoutMs = validStreamIdleTimeout(
      config.streamIdleTimeoutMs ?? DEFAULT_HERMES_STREAM_IDLE_TIMEOUT_MS,
    );
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
    const required = ["run_submission", "run_status", "run_events_sse", "run_stop", "run_approval_response"];
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
      status: response.status === "started" || (
        typeof response.status === "string"
        && HERMES_RUN_STATUSES.has(response.status as HermesRunStatus)
      )
        ? response.status
        : "started",
    };
  }

  async getRun(runId: string, options?: AbortSignal | HermesRequestOptions): Promise<HermesRunSnapshot> {
    requireHermesRunId(runId);
    const requestOptions = normalizeHermesRequestOptions(options);
    const response = await this.requestJson<unknown>(`/v1/runs/${encodeURIComponent(runId)}`, {
      method: "GET",
      headers: this.sessionHeaders(requestOptions.sessionKey),
      ...signalInit(requestOptions.signal),
    });
    return parseHermesRunSnapshot(response, runId);
  }

  async stopRun(runId: string, options?: AbortSignal | HermesRequestOptions): Promise<{ run_id: string; status: "stopping" }> {
    requireHermesRunId(runId);
    const requestOptions = normalizeHermesRequestOptions(options);
    const response = await this.requestJson<Record<string, unknown>>(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      body: "{}",
      headers: this.sessionHeaders(requestOptions.sessionKey),
      ...signalInit(requestOptions.signal),
    });
    if (
      response.run_id !== runId ||
      response.status !== "stopping" ||
      (response.runId !== undefined && response.runId !== runId)
    ) {
      throw new Error("Hermes returned an invalid stop confirmation.");
    }
    return { run_id: runId, status: "stopping" };
  }

  async submitApproval(
    runId: string,
    choice: ApprovalChoice,
    options: { approvalId?: string; resolveAll?: boolean; signal?: AbortSignal; sessionKey?: string } = {},
  ): Promise<ApprovalResult> {
    requireHermesRunId(runId);
    return await this.requestJson<ApprovalResult>(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      body: JSON.stringify({
        choice,
        resolve_all: options.resolveAll ?? false,
        ...(options.approvalId ? { approval_id: options.approvalId } : {}),
      }),
      headers: this.sessionHeaders(options.sessionKey),
      ...signalInit(options.signal),
    });
  }

  async *streamRunEvents(runId: string, options?: AbortSignal | HermesRequestOptions): AsyncGenerator<HermesRunEvent> {
    requireHermesRunId(runId);
    const requestOptions = normalizeHermesRequestOptions(options);
    const path = `/v1/runs/${encodeURIComponent(runId)}/events`;
    const publicPath = "/v1/runs/{run_id}/events";
    const idleTimeoutMessage =
      `Hermes events stream was idle for ${this.streamIdleTimeoutMs}ms: ${publicPath}`;
    const requestSignal = createRequestSignal(
      requestOptions.signal,
      this.timeoutMs,
      `Hermes events request timed out after ${this.timeoutMs}ms: ${publicPath}`,
    );
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        redirect: "error",
        headers: this.headers({ accept: "text/event-stream", ...this.sessionHeaders(requestOptions.sessionKey) }),
        signal: requestSignal.signal,
      });
      if (!response.ok) {
        const metadata = await readHermesErrorMetadata(response, MAX_HERMES_JSON_RESPONSE_BYTES);
        throw new HermesRequestError(
          response.status,
          publicPath,
          metadata.retryAfter,
          "Hermes events request failed",
          metadata.errorCode,
        );
      }
      if (!response.body) {
        throw new Error("Hermes events response did not include a body.");
      }
      requestSignal.clearTimeout();
      yield* parseSseStream(response.body, {
        idleTimeoutMs: this.streamIdleTimeoutMs,
        idleTimeoutMessage,
        onIdle: () => requestSignal.abort(new Error(idleTimeoutMessage)),
      });
    } catch (error) {
      throw requestSignal.timedOut()
        ? new Error(`Hermes events request timed out after ${this.timeoutMs}ms: ${publicPath}`)
        : error;
    } finally {
      requestSignal.cleanup();
    }
  }

  private async requestJson<T>(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<T> {
    const publicPath = publicHermesRequestPath(path);
    const requestSignal = createRequestSignal(
      init.signal ?? undefined,
      this.timeoutMs,
      `Hermes request timed out after ${this.timeoutMs}ms: ${publicPath}`,
    );
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        redirect: "error",
        signal: requestSignal.signal,
        headers: this.headers(init.headers),
      });
      if (!response.ok) {
        const metadata = await readHermesErrorMetadata(response, MAX_HERMES_JSON_RESPONSE_BYTES);
        throw new HermesRequestError(
          response.status,
          publicPath,
          metadata.retryAfter,
          "Hermes request failed",
          metadata.errorCode,
        );
      }
      const body = await readBoundedResponseText(response, MAX_HERMES_JSON_RESPONSE_BYTES);
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new Error(`Hermes returned invalid JSON for ${publicPath}.`);
      }
    } catch (error) {
      throw requestSignal.timedOut()
        ? new Error(`Hermes request timed out after ${this.timeoutMs}ms: ${publicPath}`)
        : error;
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

async function readHermesErrorMetadata(
  response: Response,
  maximumBytes: number,
): Promise<{ retryAfter?: string; errorCode?: string }> {
  const retryAfter = boundedRetryAfter(response);
  let body: string;
  try {
    body = await readBoundedResponseText(response, maximumBytes);
  } catch {
    // An unreadable or oversized body cannot prove a safe POST rejection.
    return { retryAfter };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { retryAfter };
  }
  if (!isRecord(parsed)) return { retryAfter };
  const nested = isRecord(parsed.error) ? parsed.error.code : undefined;
  const errorCode = boundedHermesErrorCode(nested ?? parsed.code);
  return { retryAfter, ...(errorCode ? { errorCode } : {}) };
}

function parseHermesRunSnapshot(value: unknown, expectedRunId: string): HermesRunSnapshot {
  if (!isRecord(value)) {
    throw invalidHermesRunSnapshot("response must be an object");
  }
  if (value.object !== "hermes.run") {
    throw invalidHermesRunSnapshot("object must be hermes.run");
  }
  if (!isBoundedHermesIdentifier(value.run_id)) {
    throw invalidHermesRunSnapshot("run_id must be a bounded identifier");
  }
  if (value.run_id !== expectedRunId) {
    throw invalidHermesRunSnapshot("run_id did not match the requested run");
  }
  if (value.runId !== undefined) {
    if (!isBoundedHermesIdentifier(value.runId) || value.runId !== value.run_id) {
      throw invalidHermesRunSnapshot("run identifier aliases conflict");
    }
  }
  if (typeof value.status !== "string" || !HERMES_RUN_STATUSES.has(value.status as HermesRunStatus)) {
    throw invalidHermesRunSnapshot("status is unsupported");
  }

  const status = value.status as HermesRunStatus;
  const snapshot: HermesRunSnapshotBase = {
    object: "hermes.run",
    run_id: value.run_id,
    status,
  };

  copyOptionalRunIdentifier(value, snapshot, "session_id");
  copyOptionalRunMetadata(value, snapshot, "model");
  copyOptionalRunMetadata(value, snapshot, "last_event");
  copyOptionalRunTimestamp(value, snapshot, "created_at");
  copyOptionalRunTimestamp(value, snapshot, "updated_at");

  if (status === "completed") {
    if (typeof value.output !== "string") {
      throw invalidHermesRunSnapshot("completed output is missing");
    }
    const outputTruncated = value.output.length > MAX_HERMES_RUN_OUTPUT_CHARS;
    return {
      ...snapshot,
      status,
      output: value.output.slice(0, MAX_HERMES_RUN_OUTPUT_CHARS),
      ...(outputTruncated ? { outputTruncated: true } : {}),
      usage: parseHermesRunUsage(value.usage),
    };
  }
  if (status === "failed") {
    // Upstream failure text can contain provider, tool, host-path, or secret
    // details. The task runtime needs only the terminal fact; keep diagnostics
    // on the Hermes side and expose a stable generic boundary value here.
    return { ...snapshot, status, error: "Hermes run failed." };
  }
  if (status === "cancelled") {
    return { ...snapshot, status };
  }
  return { ...snapshot, status };
}

function parseHermesRunUsage(value: unknown): HermesRunUsage {
  if (!isRecord(value)) {
    throw invalidHermesRunSnapshot("completed usage must be an object");
  }
  const inputTokens = boundedTokenCount(value.input_tokens);
  const outputTokens = boundedTokenCount(value.output_tokens);
  const totalTokens = boundedTokenCount(value.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    throw invalidHermesRunSnapshot("completed usage contains invalid token counts");
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function boundedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function copyOptionalRunIdentifier(
  source: Record<string, unknown>,
  target: HermesRunSnapshotBase,
  key: "session_id",
): void {
  const value = source[key];
  if (value === undefined) return;
  if (!isBoundedHermesIdentifier(value)) {
    throw invalidHermesRunSnapshot(`${key} must be a bounded identifier`);
  }
  target[key] = value;
}

function copyOptionalRunMetadata(
  source: Record<string, unknown>,
  target: HermesRunSnapshotBase,
  key: "model" | "last_event",
): void {
  const value = source[key];
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_HERMES_RUN_METADATA_CHARS ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw invalidHermesRunSnapshot(`${key} must be bounded text`);
  }
  target[key] = value;
}

function copyOptionalRunTimestamp(
  source: Record<string, unknown>,
  target: HermesRunSnapshotBase,
  key: "created_at" | "updated_at",
): void {
  const value = source[key];
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidHermesRunSnapshot(`${key} must be a non-negative finite number`);
  }
  target[key] = value;
}

function invalidHermesRunSnapshot(reason: string): Error {
  return new Error(`Hermes returned an invalid run snapshot: ${reason}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireHermesRunId(runId: string): void {
  if (!isBoundedHermesIdentifier(runId)) {
    throw new Error("Hermes run id must be a bounded identifier.");
  }
}

function boundedRetryAfter(response: Response): string | undefined {
  return boundedRetryAfterValue(response.headers.get("retry-after") ?? undefined);
}

function boundedRetryAfterValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_HERMES_RETRY_AFTER_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return undefined;
  }
  if (/^\d{1,10}$/u.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) && seconds <= MAX_HERMES_RETRY_AFTER_SECONDS
      ? String(seconds)
      : undefined;
  }
  return /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(normalized) &&
    Number.isFinite(Date.parse(normalized))
    ? normalized
    : undefined;
}

function boundedHermesErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_.-]{0,127}$/u.test(value)
    ? value
    : undefined;
}

function normalizeHermesRequestOptions(options: AbortSignal | HermesRequestOptions | undefined): HermesRequestOptions {
  if (!options) {
    return {};
  }
  return "aborted" in options && "addEventListener" in options ? { signal: options } : options;
}

function isBoundedHermesIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function publicHermesRequestPath(path: string): string {
  if (["/health", "/v1/capabilities", "/v1/runs"].includes(path)) return path;
  if (/^\/v1\/runs\/[^/]+\/events$/u.test(path)) return "/v1/runs/{run_id}/events";
  if (/^\/v1\/runs\/[^/]+\/stop$/u.test(path)) return "/v1/runs/{run_id}/stop";
  if (/^\/v1\/runs\/[^/]+\/approval$/u.test(path)) return "/v1/runs/{run_id}/approval";
  if (/^\/v1\/runs\/[^/]+$/u.test(path)) return "/v1/runs/{run_id}";
  return "/unknown";
}

function validStreamIdleTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMER_TIMEOUT_MS) {
    throw new Error("Hermes event-stream idle timeout must be a positive timer-safe integer.");
  }
  return value;
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
  abort(reason: Error): void;
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
    abort: (reason) => controller.abort(reason),
    cleanup: () => {
      clearRequestTimeout();
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}
