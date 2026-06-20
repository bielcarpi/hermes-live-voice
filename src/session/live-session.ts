import { createHash, randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { isPcmMimeType } from "../audio/pcm.js";
import { makeSessionKey, type AppConfig } from "../config.js";
import { HermesClient } from "../hermes/client.js";
import type { Logger } from "../logger.js";
import {
  ApprovalChoiceSchema,
  parseClientMessage,
  serverMessage,
  type ClientMessage,
  type HermesRunEvent,
  type LiveModelEvent,
  type LiveToolCall,
  type ServerMessage,
} from "../protocol.js";
import { buildSystemInstruction, type LiveModelAdapter, type LiveModelSession } from "../realtime/live.js";

export interface LiveGatewaySessionDeps {
  config: AppConfig;
  hermes: HermesClient;
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

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: LiveGatewaySessionDeps,
  ) {}

  bind(): void {
    this.socket.on("message", (data) => {
      void this.handleRawMessage(data).catch((error) => this.fail("client_message_failed", error));
    });
    this.socket.on("close", () => {
      void this.close();
    });
    this.socket.on("error", (error) => {
      this.deps.logger.warn("client websocket error", { sessionId: this.id, error: String(error) });
    });
  }

  async start(message: Extract<ClientMessage, { type: "session.start" }>): Promise<void> {
    if (this.liveSession || this.starting) {
      this.fail("session_already_started", new Error("Realtime session is already started."), true);
      return;
    }

    this.starting = true;
    try {
      this.profileId = message.profileId ?? "default";
      this.userLabel = message.userLabel ?? "anonymous";
      this.sessionKey = makeSessionKey(this.deps.config.server.sessionPrefix, this.profileId, this.userLabel);
      const capabilities = await this.deps.hermes.assertRunsSupported(this.abort.signal);
      const pendingEvents: LiveModelEvent[] = [];
      let providerOpen = false;
      let readySent = false;
      const sendReady = () => {
        if (readySent || !providerOpen || !this.liveSession || this.closing) {
          return;
        }
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
        for (const event of pendingEvents.splice(0)) {
          this.handleLiveModelEvent(event);
        }
      };
      const liveSession = await this.deps.liveModel.connect({
        sessionId: this.id,
        systemInstruction: buildSystemInstruction(),
        ...(this.sessionKey ? { safetyIdentifier: safetyIdentifierForSessionKey(this.sessionKey) } : {}),
        callbacks: {
          onOpen: () => {
            providerOpen = true;
            sendReady();
          },
          onClose: (event) => {
            this.send({ type: "log", level: "info", message: "Realtime provider session closed", data: event });
            if (!this.closing) {
              this.fail("realtime_provider_closed", new Error("Realtime provider session closed."), true);
              void this.close().finally(() => this.socket.close(1011, "realtime provider closed"));
            }
          },
          onError: (error) => this.fail("realtime_provider_error", error, true),
          onEvent: (event) => {
            if (!readySent) {
              pendingEvents.push(event);
              return;
            }
            this.handleLiveModelEvent(event);
          },
        },
      });
      if (this.closing) {
        await liveSession.close().catch(() => undefined);
        return;
      }
      this.liveSession = liveSession;
      sendReady();
    } catch (error) {
      if (!this.closing) {
        this.fail("session_start_failed", error, true);
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
      await this.deps.hermes.stopRun(this.activeRunId).catch(() => undefined);
    }
    this.abort.abort();
    await this.liveSession?.close().catch(() => undefined);
  }

  private async handleRawMessage(raw: WebSocket.RawData): Promise<void> {
    if (typeof raw !== "string" && !Buffer.isBuffer(raw)) {
      this.fail("unsupported_frame", new Error("Only JSON text frames are supported in v1."));
      return;
    }
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
    const parsed = JSON.parse(text) as unknown;
    await this.handleClientMessage(parseClientMessage(parsed));
  }

  private async handleClientMessage(message: ClientMessage): Promise<void> {
    if (message.type === "session.start") {
      await this.start(message);
      return;
    }
    if (!this.liveSession) {
      this.fail("session_not_started", new Error("Send session.start before streaming input."), true);
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
        await this.liveSession.sendText(message.text);
        break;
      case "response.cancel":
        await this.cancelRealtimeResponse(message.reason);
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
        this.socket.close(1000, "session closed");
        break;
    }
  }

  private async handleToolCall(call: LiveToolCall): Promise<void> {
    switch (call.name) {
      case "start_hermes_run": {
        const message = stringArg(call, "message");
        if (!message) {
          throw new Error("start_hermes_run requires message.");
        }
        const recentContext = stringArg(call, "recent_voice_context");
        const result = await this.startHermesRun(message, recentContext);
        await this.liveSession?.sendToolResponse(call, result);
        break;
      }
      case "get_hermes_run_status": {
        const runId = stringArg(call, "run_id") || this.activeRunId;
        if (!runId) {
          throw new Error("No active Hermes run.");
        }
        const status = await this.deps.hermes.getRun(runId, this.abort.signal);
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
        const runId = stringArg(call, "run_id");
        if (!runId) {
          throw new Error("submit_hermes_approval requires run_id.");
        }
        const parsedChoice = ApprovalChoiceSchema.parse(stringArg(call, "choice"));
        const result = await this.deps.hermes.submitApproval(runId, parsedChoice, {
          resolveAll: Boolean(call.args.resolve_all),
          signal: this.abort.signal,
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
        await this.sendToolFailure(event.call, error);
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

      for await (const event of this.deps.hermes.streamRunEvents(runId, this.abort.signal)) {
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
          return { ok: false, run_id: runId, status: "failed", output: transcript.join(""), error: String(event.error ?? "Hermes run failed.") };
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
      const message = errorToMessage(error);
      this.send({ type: "run.failed", runId, error: message });
      return { ok: false, run_id: runId, status: "failed", error: message };
    } finally {
      this.hermesRunActive = false;
      if (runId && this.activeRunId === runId) {
        this.activeRunId = undefined;
      }
    }
  }

  private forwardRunEvent(runId: string, event: HermesRunEvent): void {
    this.send({ type: "run.event", runId, event });
    if (event.event === "approval.request") {
      this.send({ type: "approval.request", runId, event });
    } else if (event.event === "run.failed") {
      this.send({ type: "run.failed", runId, error: String(event.error ?? "Hermes run failed.") });
    } else if (event.event === "run.cancelled") {
      this.send({ type: "run.stopped", runId, status: "cancelled" });
    }
  }

  private async handleApprovalResponse(message: Extract<ClientMessage, { type: "approval.respond" }>): Promise<void> {
    const result = await this.deps.hermes.submitApproval(message.runId, message.choice, {
      ...(message.resolveAll === undefined ? {} : { resolveAll: message.resolveAll }),
      signal: this.abort.signal,
    });
    this.send({
      type: "approval.responded",
      runId: message.runId,
      choice: message.choice,
      ...(result.resolved === undefined ? {} : { resolved: result.resolved }),
    });
  }

  private async stopRun(runId: string | undefined, reason?: string): Promise<Record<string, unknown>> {
    const target = runId || this.activeRunId;
    if (!target) {
      return { ok: false, error: "No active Hermes run." };
    }
    const result = await this.deps.hermes.stopRun(target, this.abort.signal);
    this.send({ type: "run.stopped", runId: target, status: result.status ?? "stopping" });
    this.send({ type: "log", level: "info", message: "Hermes run stop requested", data: { runId: target, reason } });
    return { ok: true, run_id: target, status: result.status ?? "stopping" };
  }

  private async cancelRealtimeResponse(reason?: string): Promise<void> {
    try {
      const cancelled = (await this.liveSession?.cancelResponse(reason)) ?? false;
      this.send({
        type: "log",
        level: cancelled ? "info" : "debug",
        message: cancelled ? "Realtime response cancellation requested" : "No active realtime response to cancel",
        data: { reason },
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
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(serverMessage(message));
    }
  }

  private fail(code: string, error: unknown, recoverable = false): void {
    const message = errorToMessage(error);
    this.deps.logger.warn("live session error", { sessionId: this.id, code, message });
    this.send({ type: "session.error", code, message, recoverable });
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

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safetyIdentifierForSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex");
}

function stringArg(call: LiveToolCall, name: string): string {
  const value = call.args[name];
  return typeof value === "string" ? value : "";
}
