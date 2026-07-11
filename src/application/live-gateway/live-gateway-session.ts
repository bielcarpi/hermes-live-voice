import { createHash, randomUUID } from "node:crypto";
import { isPcmMimeType } from "../../domain/audio/pcm.js";
import { makeSessionKey, type AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import {
  ApprovalChoiceSchema,
  parseClientMessage,
  type ClientMessage,
  type RealtimeResponseTruncation,
} from "../../domain/protocol/client-protocol.js";
import {
  serverMessage,
  type HermesRunEvent,
  type ServerMessage,
} from "../../domain/protocol/server-protocol.js";
import type { ClientConnectionPort, ClientInboundFrame } from "./ports/client-connection.port.js";
import type { HermesRunsPort } from "./ports/hermes-runs.port.js";
import {
  type LiveModelEvent,
  type LiveToolCall,
  type LiveModelAdapter,
  type LiveModelSession,
} from "./ports/realtime-model.port.js";
import { buildSystemInstruction } from "./system-instruction.js";

export interface LiveGatewaySessionDeps {
  config: AppConfig;
  hermes: HermesRunsPort;
  liveModel: LiveModelAdapter;
  logger: Logger;
}

export class LiveGatewaySession {
  private readonly id = `live_${randomUUID().replaceAll("-", "")}`;
  private readonly abort = new AbortController();
  private liveSession?: LiveModelSession;
  private starting = false;
  private closing = false;
  private sessionKey?: string;
  private profileId = "default";
  private userLabel = "anonymous";
  private activeRunId: string | undefined;
  private hermesRunActive = false;
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: ClientConnectionPort,
    private readonly deps: LiveGatewaySessionDeps,
  ) {}

  bind(): void {
    this.client.onMessage((data) => {
      this.messageQueue = this.messageQueue.then(() => this.handleRawMessage(data));
    });
    this.client.onClose(() => {
      void this.close();
    });
    this.client.onError((error) => {
      this.deps.logger.warn("client connection error", { sessionId: this.id, error: String(error) });
    });
  }

  async start(message: Extract<ClientMessage, { type: "session.start" }>): Promise<void> {
    if (this.liveSession || this.starting) {
      this.fail("session_already_started", new Error("Realtime session is already started."), true, message.id);
      return;
    }

    this.starting = true;
    let liveSession: LiveModelSession | undefined;
    let clearProviderReadyTimeout = () => {};
    try {
      this.profileId = this.deps.config.server.trustClientIdentity
        ? message.profileId ?? this.deps.config.server.defaultProfileId
        : this.deps.config.server.defaultProfileId;
      this.userLabel = this.deps.config.server.trustClientIdentity
        ? message.userLabel ?? this.deps.config.server.defaultUserLabel
        : this.deps.config.server.defaultUserLabel;
      this.sessionKey = makeSessionKey(this.deps.config.server.sessionPrefix, this.profileId, this.userLabel);
      const capabilities = await this.deps.hermes.assertRunsSupported(this.abort.signal);
      const pendingEvents: LiveModelEvent[] = [];
      let providerOpen = false;
      let readySent = false;
      let providerStartupFailed = false;
      let providerReadyTimedOut = false;
      let providerReadyTimeout: ReturnType<typeof setTimeout> | undefined;
      let resolveProviderReady!: () => void;
      let rejectProviderReady!: (error: Error) => void;
      const providerReady = new Promise<void>((resolve) => {
        resolveProviderReady = resolve;
      });
      const providerReadyFailure = new Promise<never>((_, reject) => {
        rejectProviderReady = reject;
      });
      const providerReadyDeadline = new Promise<never>((_, reject) => {
        providerReadyTimeout = setTimeout(() => {
          providerReadyTimedOut = true;
          reject(new Error(`Realtime provider did not become ready within ${this.deps.config.server.providerReadyTimeoutMs}ms.`));
        }, this.deps.config.server.providerReadyTimeoutMs);
      });
      clearProviderReadyTimeout = () => {
        if (providerReadyTimeout) {
          clearTimeout(providerReadyTimeout);
          providerReadyTimeout = undefined;
        }
      };
      const failProviderStartup = (error: unknown): boolean => {
        if (readySent || this.closing) {
          return false;
        }
        providerStartupFailed = true;
        rejectProviderReady(error instanceof Error ? error : new Error(errorToMessage(error)));
        return true;
      };
      const sendReady = () => {
        if (readySent || !providerOpen || !this.liveSession || this.closing) {
          return;
        }
        clearProviderReadyTimeout();
        const hermesInfo: { model?: string; capabilities?: Record<string, unknown> } = {};
        if (typeof capabilities.model === "string") {
          hermesInfo.model = capabilities.model;
        }
        if (capabilities.features) {
          hermesInfo.capabilities = capabilities.features;
        }
        this.send({
          type: "session.ready",
          sessionId: this.id,
          model: this.deps.config.realtime.model,
          hermes: hermesInfo,
        });
        readySent = true;
        resolveProviderReady();
        for (const event of pendingEvents.splice(0)) {
          this.handleLiveModelEvent(event);
        }
      };
      const connect = this.deps.liveModel
        .connect({
          sessionId: this.id,
          systemInstruction: buildSystemInstruction(),
          ...(this.sessionKey ? { safetyIdentifier: safetyIdentifierForSessionKey(this.sessionKey) } : {}),
          callbacks: {
            onOpen: () => {
              providerOpen = true;
              sendReady();
            },
            onClose: (event) => {
              if (failProviderStartup(new Error("Realtime provider session closed before ready."))) {
                return;
              }
              this.send({ type: "log", level: "info", message: "Realtime provider session closed", data: event });
              if (!this.closing) {
                this.fail("realtime_provider_closed", new Error("Realtime provider session closed."), true);
                void this.close().finally(() => this.client.close(1011, "realtime provider closed"));
              }
            },
            onError: (error) => {
              if (failProviderStartup(error)) {
                return;
              }
              this.fail("realtime_provider_error", error, true);
            },
            onEvent: (event) => {
              if (!readySent) {
                pendingEvents.push(event);
                return;
              }
              this.handleLiveModelEvent(event);
            },
          },
        })
        .then(async (session) => {
          if (providerReadyTimedOut || providerStartupFailed || this.closing) {
            await session.close().catch(() => undefined);
          }
          return session;
        });
      liveSession = await Promise.race([connect, providerReadyDeadline, providerReadyFailure]);
      if (this.closing) {
        clearProviderReadyTimeout();
        await liveSession.close().catch(() => undefined);
        return;
      }
      this.liveSession = liveSession;
      sendReady();
      await Promise.race([providerReady, providerReadyDeadline, providerReadyFailure]);
    } catch (error) {
      clearProviderReadyTimeout();
      await liveSession?.close().catch(() => undefined);
      if (liveSession && this.liveSession === liveSession) {
        this.liveSession = undefined;
      }
      if (!this.closing) {
        this.fail("session_start_failed", error, true, message.id);
      }
    } finally {
      this.starting = false;
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    if (this.activeRunId) {
      await this.deps.hermes.stopRun(this.activeRunId, this.hermesRequestOptions()).catch(() => undefined);
    }
    this.abort.abort();
    await this.liveSession?.close().catch(() => undefined);
  }

  private async handleRawMessage(raw: ClientInboundFrame): Promise<void> {
    let requestId: string | undefined;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      const parsed = JSON.parse(text) as unknown;
      requestId = requestIdFromUnknown(parsed);
      await this.handleClientMessage(parseClientMessage(parsed));
    } catch (error) {
      this.fail("client_message_failed", error, false, requestId);
    }
  }

  private async handleClientMessage(message: ClientMessage): Promise<void> {
    if (message.type === "session.start") {
      await this.start(message);
      return;
    }
    if (!this.liveSession) {
      this.fail("session_not_started", new Error("Send session.start before streaming input."), true, message.id);
      return;
    }
    switch (message.type) {
      case "audio.input":
        validateAudioFrame(message.data, message.mimeType, this.deps.config.server.maxAudioBytes);
        await this.liveSession.sendRealtimeAudio({ data: message.data, mimeType: message.mimeType });
        break;
      case "audio.end":
        await this.liveSession.sendAudioStreamEnd();
        break;
      case "text.input":
        validateText(message.text, this.deps.config.server.maxTextChars, "Text input");
        await this.liveSession.sendText(message.text);
        break;
      case "response.cancel":
        await this.cancelRealtimeResponse(message.reason, message.truncate);
        break;
      case "approval.respond":
        await this.handleApprovalResponse(message);
        break;
      case "run.stop":
        await this.cancelRealtimeResponse(message.reason);
        await this.stopRun(message.runId, message.reason);
        break;
      case "session.close":
        await this.close();
        this.client.close(1000, "session closed");
        break;
    }
  }

  private async handleToolCall(call: LiveToolCall): Promise<void> {
    if (!call.id) {
      throw new Error(`Realtime tool call ${call.name || "<unknown>"} did not include an id.`);
    }
    switch (call.name) {
      case "start_hermes_run": {
        const message = stringArg(call, "message");
        if (!message) {
          throw new Error("start_hermes_run requires message.");
        }
        validateText(message, this.deps.config.server.maxTextChars, "Hermes run message");
        const recentContext = stringArg(call, "recent_voice_context");
        if (recentContext) {
          validateText(recentContext, this.deps.config.server.maxTextChars, "Recent voice context");
        }
        const result = await this.startHermesRun(message, recentContext);
        await this.liveSession?.sendToolResponse(call, result);
        break;
      }
      case "get_hermes_run_status": {
        const runId = this.resolveActiveRunId(stringArg(call, "run_id") || undefined);
        const status = await this.deps.hermes.getRun(runId, this.hermesRequestOptions());
        await this.liveSession?.sendToolResponse(call, { ok: true, status });
        break;
      }
      case "stop_hermes_run": {
        const runId = stringArg(call, "run_id") || this.activeRunId;
        const stopped = await this.stopRun(runId, stringArg(call, "reason"));
        await this.liveSession?.sendToolResponse(call, stopped);
        break;
      }
      case "submit_hermes_approval": {
        const runId = this.resolveActiveRunId(stringArg(call, "run_id") || undefined);
        const parsedChoice = ApprovalChoiceSchema.parse(stringArg(call, "choice"));
        const result = await this.deps.hermes.submitApproval(runId, parsedChoice, {
          resolveAll: Boolean(call.args.resolve_all),
          ...this.hermesRequestOptions(),
        });
        await this.liveSession?.sendToolResponse(call, { ok: true, result });
        break;
      }
      default:
        await this.liveSession?.sendToolResponse(call, { ok: false, error: `Unknown hermes-live tool: ${call.name}` });
    }
  }

  private handleLiveModelEvent(event: LiveModelEvent): void {
    if (event.type === "audio") {
      this.send({ type: "audio.output", ...event.audio });
    } else if (event.type === "text") {
      this.send({ type: "transcript.delta", speaker: "assistant", text: event.text });
    } else if (event.type === "tool_call") {
      void this.handleToolCall(event.call).catch(async (error) => {
        this.fail("tool_call_failed", error, true);
        if (event.call.id) {
          await this.sendToolFailure(event.call, error);
        }
      });
    } else if (event.type === "input_speech_started") {
      this.send({
        type: "input.speech_started",
        provider: event.provider,
        ...(event.itemId ? { itemId: event.itemId } : {}),
        ...(event.audioStartMs === undefined ? {} : { audioStartMs: event.audioStartMs }),
      });
    } else {
      this.send({ type: "realtime.message", message: event.message });
    }
  }

  private async startHermesRun(message: string, recentVoiceContext?: string): Promise<Record<string, unknown>> {
    if (!this.sessionKey) {
      throw new Error("session.start has not completed.");
    }
    if (this.hermesRunActive) {
      return { ok: false, error: "A Hermes run is already active for this voice session." };
    }

    this.hermesRunActive = true;
    let runId: string | undefined;
    const input = recentVoiceContext ? `${message}\n\nRecent voice context:\n${recentVoiceContext}` : message;
    const runParams = {
      input,
      sessionId: this.id,
      sessionKey: this.sessionKey,
      ...(this.deps.config.hermes.instructions ? { instructions: this.deps.config.hermes.instructions } : {}),
    };

    try {
      const started = await this.deps.hermes.startRun(runParams, this.abort.signal);
      runId = started.runId;
      this.activeRunId = runId;
      this.send({ type: "run.started", runId, sessionId: this.id });

      const transcript: string[] = [];
      let finalOutput = "";
      let usage: Record<string, unknown> | undefined;
      let terminal = false;

      for await (const event of this.deps.hermes.streamRunEvents(runId, this.hermesRequestOptions())) {
        this.forwardRunEvent(runId, event);
        if (event.event === "message.delta" && typeof event.delta === "string") {
          transcript.push(event.delta);
        } else if (event.event === "run.completed") {
          terminal = true;
          finalOutput = typeof event.output === "string" ? event.output : transcript.join("");
          usage = event.usage;
          this.send({
            type: "run.completed",
            runId,
            output: finalOutput || transcript.join(""),
            ...(usage ? { usage } : {}),
          });
        } else if (event.event === "run.failed") {
          terminal = true;
          this.deps.logger.warn("Hermes run reported failure", {
            sessionId: this.id,
            runId,
            error: String(event.error ?? "Hermes run failed."),
          });
          return {
            ok: false,
            run_id: runId,
            status: "failed",
            output: transcript.join(""),
            error: "Hermes run failed. Check the gateway logs for details.",
          };
        } else if (event.event === "run.cancelled") {
          terminal = true;
          return { ok: false, run_id: runId, status: "cancelled" };
        }
      }

      if (!terminal) {
        const output = transcript.join("");
        const error = "Hermes run event stream ended before a terminal event.";
        this.send({ type: "run.failed", runId, error });
        return { ok: false, run_id: runId, status: "incomplete", output, error };
      }

      return { ok: true, run_id: runId, output: finalOutput || transcript.join(""), usage };
    } catch (error) {
      if (!runId) {
        throw error;
      }
      this.deps.logger.warn("Hermes run bridge failed", { sessionId: this.id, runId, error: errorToMessage(error) });
      const publicMessage = "Hermes run failed. Check the gateway logs for details.";
      this.send({ type: "run.failed", runId, error: publicMessage });
      return { ok: false, run_id: runId, status: "failed", error: publicMessage };
    } finally {
      this.hermesRunActive = false;
      if (runId && this.activeRunId === runId) {
        this.activeRunId = undefined;
      }
    }
  }

  private forwardRunEvent(runId: string, event: HermesRunEvent): void {
    const publicEvent = publicHermesRunEvent(event, this.deps.config.server.runEventDetail);
    if (publicEvent) {
      this.send({ type: "run.event", runId, event: publicEvent });
    }
    if (event.event === "approval.request") {
      this.send({ type: "approval.request", runId, event: publicEvent ?? publicHermesRunEvent(event, "summary")! });
    } else if (event.event === "run.failed") {
      this.send({ type: "run.failed", runId, error: "Hermes run failed. Check the gateway logs for details." });
    } else if (event.event === "run.cancelled") {
      this.send({ type: "run.stopped", runId, status: "cancelled" });
    }
  }

  private async handleApprovalResponse(message: Extract<ClientMessage, { type: "approval.respond" }>): Promise<void> {
    const runId = this.resolveActiveRunId(message.runId);
    const result = await this.deps.hermes.submitApproval(runId, message.choice, {
      ...(message.resolveAll === undefined ? {} : { resolveAll: message.resolveAll }),
      ...this.hermesRequestOptions(),
    });
    this.send({
      type: "approval.responded",
      runId,
      choice: message.choice,
      ...(result.resolved === undefined ? {} : { resolved: result.resolved }),
    });
  }

  private async stopRun(runId: string | undefined, reason?: string): Promise<Record<string, unknown>> {
    const target = this.resolveActiveRunId(runId);
    const result = await this.deps.hermes.stopRun(target, this.hermesRequestOptions());
    this.send({ type: "run.stopped", runId: target, status: result.status ?? "stopping" });
    this.send({ type: "log", level: "info", message: "Hermes run stop requested", data: { runId: target, reason } });
    return { ok: true, run_id: target, status: result.status ?? "stopping" };
  }

  private hermesRequestOptions(): { signal: AbortSignal; sessionKey?: string } {
    return { signal: this.abort.signal, ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}) };
  }

  private resolveActiveRunId(requestedRunId: string | undefined): string {
    if (!this.activeRunId) {
      throw new Error("No active Hermes run.");
    }
    if (requestedRunId && requestedRunId !== this.activeRunId) {
      throw new Error("Requested Hermes run is not active in this voice session.");
    }
    return this.activeRunId;
  }

  private async cancelRealtimeResponse(reason?: string, truncate?: RealtimeResponseTruncation): Promise<void> {
    try {
      const cancelled = (await this.liveSession?.cancelResponse(reason, truncate)) ?? false;
      this.send({
        type: "log",
        level: cancelled ? "info" : "debug",
        message: cancelled ? "Realtime response cancellation requested" : "No active realtime response to cancel",
        data: { reason, truncate },
      });
    } catch (error) {
      this.deps.logger.warn("failed to cancel realtime response", {
        sessionId: this.id,
        error: errorToMessage(error),
      });
      this.send({ type: "log", level: "warn", message: "Realtime response cancellation failed", data: { reason } });
    }
  }

  private async sendToolFailure(call: LiveToolCall, error: unknown): Promise<void> {
    try {
      await this.liveSession?.sendToolResponse(call, { ok: false, error: errorToMessage(error) });
    } catch (toolError) {
      this.deps.logger.warn("failed to send realtime tool failure", {
        sessionId: this.id,
        callId: call.id,
        error: errorToMessage(toolError),
      });
    }
  }

  private send(message: ServerMessage): void {
    this.client.sendText(serverMessage(message));
  }

  private fail(code: string, error: unknown, recoverable = false, requestId?: string): void {
    const message = errorToMessage(error);
    this.deps.logger.warn("live session error", { sessionId: this.id, code, message });
    this.send({ type: "session.error", code, message, recoverable, ...(requestId ? { requestId } : {}) });
  }
}

function validateAudioFrame(data: string, mimeType: string, maxBytes: number): void {
  const decoded = decodeBase64Audio(data);
  if (decoded.length > maxBytes) {
    throw new Error("Audio frame exceeds HERMES_LIVE_MAX_AUDIO_BYTES.");
  }
  if (isPcmMimeType(mimeType) && decoded.length % 2 !== 0) {
    throw new Error("PCM16 audio frames must contain an even number of bytes.");
  }
}

function decodeBase64Audio(data: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) {
    throw new Error("Audio frame data must be base64 encoded.");
  }
  return Buffer.from(data, "base64");
}

function validateText(value: string, maxChars: number, label: string): void {
  if (value.length > maxChars) {
    throw new Error(`${label} exceeds HERMES_LIVE_MAX_TEXT_CHARS.`);
  }
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestIdFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : undefined;
}

function safetyIdentifierForSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex");
}

function stringArg(call: LiveToolCall, name: string): string {
  const value = call.args[name];
  return typeof value === "string" ? value : "";
}

function publicHermesRunEvent(
  event: HermesRunEvent,
  detail: AppConfig["server"]["runEventDetail"],
): HermesRunEvent | undefined {
  if (detail === "raw") {
    return event;
  }
  if (detail === "none") {
    return undefined;
  }

  const summary: Record<string, unknown> = {};
  for (const key of ["event", "run_id", "timestamp", "status", "approval_id"] as const) {
    const value = event[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
    }
  }
  return summary as HermesRunEvent;
}
