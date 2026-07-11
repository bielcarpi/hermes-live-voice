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
import { parseNarratableEvent, redactForNarration } from "./run-event-parsing.js";
import { RunNarrator } from "./run-narrator.js";

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
  private runStats?: {
    runId: string;
    startedAt: number;
    toolsStarted: number;
    toolsCompleted: number;
    lastEventName?: string;
    lastEventAt?: number;
    lastReasoning?: string;
  };
  private speaking = false;
  private speakingSince = 0;
  private runNarrator?: RunNarrator;
  private userSpeaking = false;
  private clientAudioActive = false;
  private lastAudioDeltaAt = 0;
  private lastUserInputAt = 0;
  private lastNarrationAt = 0;
  private readonly sessionStartedAt = Date.now();

  constructor(
    private readonly client: ClientConnectionPort,
    private readonly deps: LiveGatewaySessionDeps,
  ) {}

  bind(): void {
    this.client.onMessage((data) => {
      void this.handleRawMessage(data);
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
      this.profileId = message.profileId ?? "default";
      this.userLabel = message.userLabel ?? "anonymous";
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
        const agentInfo: { model?: string; capabilities?: Record<string, unknown> } = {};
        if (typeof capabilities.model === "string") {
          agentInfo.model = capabilities.model;
        }
        if (capabilities.features) {
          agentInfo.capabilities = capabilities.features;
        }
        this.send({
          type: "session.ready",
          sessionId: this.id,
          model: this.deps.config.realtime.model,
          agent: agentInfo,
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
    this.deps.logger.info("session_closing", { sessionId: this.id, activeRunId: this.activeRunId ?? null, wasSpeaking: this.speaking, sessionDurationMs: Date.now() - this.sessionStartedAt });
    this.speaking = false;
    this.runNarrator?.dispose();
    this.runNarrator = undefined;
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
        if (this.isPushToTalkFallbackActive() && !this.clientAudioActive) {
          if (this.lastNarrationAt > this.lastUserInputAt) {
            await this.liveSession.cancelResponse("user_barge_in");
          }
          this.lastUserInputAt = Date.now();
          this.clientAudioActive = true;
        }
        await this.liveSession.sendRealtimeAudio({ data: message.data, mimeType: message.mimeType });
        break;
      case "audio.end":
        await this.liveSession.sendAudioStreamEnd();
        if (this.isPushToTalkFallbackActive()) {
          this.clientAudioActive = false;
          this.runNarrator?.poke();
        }
        break;
      case "text.input":
        validateText(message.text, this.deps.config.server.maxTextChars, "Text input");
        this.lastUserInputAt = Date.now();
        this.deps.logger.info("user_text_input", { sessionId: this.id, text: message.text.slice(0, 500) });
        await this.liveSession.sendText(message.text);
        break;
      case "response.cancel":
        await this.cancelRealtimeResponse(message.reason, message.truncate);
        break;
      case "approval.respond":
        await this.handleApprovalResponse(message);
        break;
      case "run.stop": {
        const requestedRunId = message.runId;
        if (requestedRunId !== undefined && requestedRunId !== this.activeRunId) {
          this.send({
            type: "log",
            level: "info",
            message: "Stop requested for a run that is not active",
            data: { requestedRunId, activeRunId: this.activeRunId ?? null },
          });
          break;
        }
        await this.cancelRealtimeResponse(message.reason);
        await this.stopRun(message.runId, message.reason);
        break;
      }
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
      case "start_agent_run": {
        const message = stringArg(call, "message");
        if (!message) {
          throw new Error("start_agent_run requires message.");
        }
        validateText(message, this.deps.config.server.maxTextChars, "Agent run message");
        const recentContext = stringArg(call, "recent_voice_context");
        if (recentContext) {
          validateText(recentContext, this.deps.config.server.maxTextChars, "Recent voice context");
        }
        const result = await this.startHermesRun(message, recentContext);
        await this.liveSession?.sendToolResponse(call, result);
        break;
      }
      case "get_agent_run_status": {
        const resolved = this.resolveRunIdTolerant(stringArg(call, "run_id") || undefined);
        if (!resolved.ok) {
          await this.liveSession?.sendToolResponse(call, resolved.result);
          break;
        }
        const status = await this.deps.hermes.getRun(resolved.runId, this.hermesRequestOptions());
        const statsMatch = this.runStats && this.runStats.runId === resolved.runId;
        const payload: Record<string, unknown> = { ok: true, status };
        if (statsMatch) {
          payload.elapsed_s = (Date.now() - this.runStats!.startedAt) / 1000;
          payload.tools_started = this.runStats!.toolsStarted;
          payload.tools_completed = this.runStats!.toolsCompleted;
          payload.last_activity = this.runStats!.lastReasoning ?? this.runStats!.lastEventName;
          if (this.runStats!.lastEventAt !== undefined) {
            payload.last_event_age_s = (Date.now() - this.runStats!.lastEventAt) / 1000;
          }
        }
        await this.liveSession?.sendToolResponse(call, payload);
        break;
      }
      case "stop_agent_run": {
        const resolved = this.resolveRunIdTolerant(stringArg(call, "run_id") || undefined);
        if (!resolved.ok) {
          await this.liveSession?.sendToolResponse(call, resolved.result);
          break;
        }
        const stopped = await this.stopRun(resolved.runId, stringArg(call, "reason"));
        await this.liveSession?.sendToolResponse(call, stopped);
        break;
      }
      case "submit_agent_approval": {
        const runId = this.resolveActiveRunIdOrThrow(stringArg(call, "run_id") || undefined);
        const parsedChoice = ApprovalChoiceSchema.parse(stringArg(call, "choice"));
        const result = await this.deps.hermes.submitApproval(runId, parsedChoice, {
          resolveAll: Boolean(call.args.resolve_all),
          ...this.hermesRequestOptions(),
        });
        this.runNarrator?.onApprovalResolved();
        await this.liveSession?.sendToolResponse(call, { ok: true, result });
        break;
      }
      case "generate_agent_random_number": {
        const receivedAt = Date.now();
        const min = numberArg(call, "min") ?? 0;
        const max = numberArg(call, "max") ?? 100;
        this.deps.logger.info("agent_random_number_requested", { sessionId: this.id, callId: call.id, rawArgs: call.args, min, max });
        const value = randomIntInRange(min, max);
        this.deps.logger.info("agent_random_number_tool_call", {
          sessionId: this.id,
          callId: call.id,
          min,
          max,
          value,
          handlerLatencyMs: Date.now() - receivedAt,
        });
        await this.liveSession?.sendToolResponse(call, { ok: true, value, min, max });
        this.deps.logger.info("agent_random_number_responded", { sessionId: this.id, callId: call.id, value });
        break;
      }
      default:
        await this.liveSession?.sendToolResponse(call, { ok: false, error: `Unknown agent tool: ${call.name}` });
    }
  }

  private handleLiveModelEvent(event: LiveModelEvent): void {
    if (event.type === "audio") {
      if (!this.speaking) {
        this.speaking = true;
        this.speakingSince = Date.now();
        this.deps.logger.info("assistant_speaking_started", { sessionId: this.id });
      }
      this.lastAudioDeltaAt = Date.now();
      this.send({ type: "audio.output", ...event.audio });
    } else if (event.type === "text") {
      this.deps.logger.info("assistant_transcript", { sessionId: this.id, text: event.text });
      this.send({ type: "transcript.delta", speaker: "assistant", text: event.text });
    } else if (event.type === "tool_call") {
      if (this.speaking) {
        const duration = this.speakingSince ? Date.now() - this.speakingSince : 0;
        this.speaking = false;
        this.deps.logger.info("assistant_speaking_stopped", { sessionId: this.id, durationMs: duration });
      }
      this.deps.logger.info("assistant_tool_call", { sessionId: this.id, tool: event.call.name });
      void this.handleToolCall(event.call).catch(async (error) => {
        this.fail("tool_call_failed", error, true);
        if (event.call.id) {
          await this.sendToolFailure(event.call, error);
        }
      });
    } else if (event.type === "input_speech_started") {
      if (this.speaking) {
        const duration = this.speakingSince ? Date.now() - this.speakingSince : 0;
        this.speaking = false;
        this.deps.logger.info("assistant_speaking_stopped", { sessionId: this.id, durationMs: duration, reason: "user_interrupted" });
      }
      if (this.lastNarrationAt > this.lastUserInputAt) {
        void this.liveSession?.cancelResponse("user_barge_in");
      }
      this.userSpeaking = true;
      this.lastUserInputAt = Date.now();
      this.deps.logger.info("user_speaking_started", { sessionId: this.id });
      this.send({
        type: "input.speech_started",
        provider: event.provider,
        ...(event.itemId ? { itemId: event.itemId } : {}),
        ...(event.audioStartMs === undefined ? {} : { audioStartMs: event.audioStartMs }),
      });
    } else if (event.type === "input_speech_stopped") {
      this.userSpeaking = false;
      this.deps.logger.info("user_speaking_stopped", { sessionId: this.id, durationS: event.durationS });
      this.send({
        type: "input.speech_stopped",
        provider: event.provider,
        ...(event.durationS === undefined ? {} : { durationS: event.durationS }),
        ...(event.audioEndMs === undefined ? {} : { audioEndMs: event.audioEndMs }),
      });
      this.runNarrator?.poke();
    } else {
      const rawType = (event.message as { type?: unknown } | null | undefined)?.type;
      if (
        typeof rawType === "string" &&
        (rawType === "response.done" || rawType === "response.cancelled" || rawType === "response.failed")
      ) {
        if (this.speaking) {
          this.speaking = false;
        }
        this.runNarrator?.poke();
      }
      this.send({ type: "realtime.message", message: event.message });
    }
  }

  private async startHermesRun(message: string, recentVoiceContext?: string): Promise<Record<string, unknown>> {
    if (!this.sessionKey) {
      throw new Error("session.start has not completed.");
    }
    if (this.hermesRunActive) {
      return { ok: false, error: "An agent run is already active for this voice session." };
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
      this.runStats = { runId, startedAt: Date.now(), toolsStarted: 0, toolsCompleted: 0 };
      const provider = this.deps.config.realtime.provider;
      if (this.deps.config.narration.enabled && (provider === "openai" || provider === "local" || provider === "mock")) {
        const narratorRunId = runId;
        this.runNarrator = new RunNarrator({
          runId: narratorRunId,
          config: this.deps.config.narration,
          deliver: async (framedText: string): Promise<boolean> => {
            const audioGapOk = Date.now() - this.lastAudioDeltaAt >= this.deps.config.narration.audioGapMs;
            if (this.speaking || this.userSpeaking || this.clientAudioActive || !audioGapOk || !this.liveSession) {
              return false;
            }
            const ok = await this.liveSession.sendNarration(framedText);
            if (ok) {
              this.lastNarrationAt = Date.now();
            }
            return ok;
          },
          cancelNarration: async (): Promise<void> => {
            if (this.lastNarrationAt > this.lastUserInputAt) {
              await this.liveSession?.cancelResponse("narration_cutoff");
            }
          },
          logger: this.deps.logger,
        });
      } else if (this.deps.config.narration.enabled && provider === "gemini") {
        this.deps.logger.warn("narration_disabled_for_provider", { sessionId: this.id, provider });
      }
      this.deps.logger.info("hermes_run_started", { sessionId: this.id, runId, input: input.slice(0, 200) });
      this.send({ type: "run.started", runId, sessionId: this.id });

      const transcript: string[] = [];
      let finalOutput = "";
      let usage: Record<string, unknown> | undefined;
      let terminal = false;

      for await (const event of this.deps.hermes.streamRunEvents(runId, this.hermesRequestOptions())) {
        this.forwardRunEvent(runId, event);
        if (this.runStats) {
          this.runStats.lastEventName = event.event as string;
          this.runStats.lastEventAt = Date.now();
        }
        const narratable = parseNarratableEvent(event);
        if (narratable) {
          if (narratable.kind === "reasoning") {
            this.runNarrator?.onEvent({ kind: "reasoning", text: redactForNarration(narratable.text) });
          } else {
            this.runNarrator?.onEvent(narratable);
          }
        }
        if (event.event === "message.delta" && typeof event.delta === "string") {
          transcript.push(event.delta);
        } else if (event.event === "reasoning.available" && typeof event.text === "string") {
          this.deps.logger.info("hermes_reasoning", { sessionId: this.id, runId, text: event.text.slice(0, 300) });
          if (this.runStats) {
            this.runStats.lastReasoning = redactForNarration(event.text as string);
          }
        } else if (event.event === "tool.started" && typeof event.tool === "string") {
          if (this.runStats) this.runStats.toolsStarted++;
          this.deps.logger.info("hermes_tool_started", { sessionId: this.id, runId, tool: event.tool });
        } else if (event.event === "tool.completed" && typeof event.tool === "string") {
          if (this.runStats) this.runStats.toolsCompleted++;
          this.deps.logger.info("hermes_tool_completed", { sessionId: this.id, runId, tool: event.tool, duration: event.duration, error: event.error ?? false });
        } else if (event.event === "run.completed") {
          terminal = true;
          finalOutput = typeof event.output === "string" ? event.output : transcript.join("");
          usage = event.usage;
          this.deps.logger.info("hermes_run_completed", {
            sessionId: this.id,
            runId,
            outputLength: (finalOutput || transcript.join("")).length,
            toolsStarted: this.runStats?.toolsStarted ?? 0,
            toolsCompleted: this.runStats?.toolsCompleted ?? 0,
          });
          this.send({
            type: "run.completed",
            runId,
            output: finalOutput || transcript.join(""),
            ...(usage ? { usage } : {}),
          });
          await this.runNarrator?.onTerminal();
        } else if (event.event === "run.failed") {
          terminal = true;
          this.deps.logger.warn("hermes_run_failed", { sessionId: this.id, runId, error: String(event.error ?? "unknown") });
          await this.runNarrator?.onTerminal();
          return { ok: false, run_id: runId, status: "failed", output: transcript.join(""), error: String(event.error ?? "Agent run failed.") };
        } else if (event.event === "run.cancelled") {
          terminal = true;
          this.deps.logger.info("hermes_run_cancelled", { sessionId: this.id, runId });
          await this.runNarrator?.onTerminal();
          return { ok: false, run_id: runId, status: "cancelled" };
        }
      }

      if (!terminal) {
        const output = transcript.join("");
        const error = "Agent run event stream ended before a terminal event.";
        this.send({ type: "run.failed", runId, error });
        await this.runNarrator?.onTerminal();
        return { ok: false, run_id: runId, status: "incomplete", output, error };
      }

      return { ok: true, run_id: runId, output: finalOutput || transcript.join(""), usage };
    } catch (error) {
      if (!runId) {
        throw error;
      }
      const message = errorToMessage(error);
      this.send({ type: "run.failed", runId, error: message });
      await this.runNarrator?.onTerminal();
      return { ok: false, run_id: runId, status: "failed", error: message };
    } finally {
      this.hermesRunActive = false;
      if (runId && this.activeRunId === runId) {
        this.activeRunId = undefined;
      }
      this.runNarrator?.dispose();
      this.runNarrator = undefined;
    }
  }

  private forwardRunEvent(runId: string, event: HermesRunEvent): void {
    this.send({ type: "run.event", runId, event });
    if (event.event === "approval.request") {
      this.deps.logger.info("hermes_approval_requested", { sessionId: this.id, runId });
      this.send({ type: "approval.request", runId, event });
    } else if (event.event === "run.failed") {
      this.send({ type: "run.failed", runId, error: String(event.error ?? "Agent run failed.") });
    } else if (event.event === "run.cancelled") {
      this.send({ type: "run.stopped", runId, status: "cancelled" });
    }
  }

  private async handleApprovalResponse(message: Extract<ClientMessage, { type: "approval.respond" }>): Promise<void> {
    const runId = this.resolveActiveRunIdOrThrow(message.runId);
    const result = await this.deps.hermes.submitApproval(runId, message.choice, {
      ...(message.resolveAll === undefined ? {} : { resolveAll: message.resolveAll }),
      ...this.hermesRequestOptions(),
    });
    this.runNarrator?.onApprovalResolved();
    this.send({
      type: "approval.responded",
      runId,
      choice: message.choice,
      ...(result.resolved === undefined ? {} : { resolved: result.resolved }),
    });
  }

  private async stopRun(runId: string | undefined, reason?: string): Promise<Record<string, unknown>> {
    const resolved = this.resolveRunIdTolerant(runId);
    if (!resolved.ok) {
      return resolved.result;
    }
    const target = resolved.runId;
    const result = await this.deps.hermes.stopRun(target, this.hermesRequestOptions());
    this.send({ type: "run.stopped", runId: target, status: result.status ?? "stopping" });
    this.send({ type: "log", level: "info", message: "Agent run stop requested", data: { runId: target, reason } });
    return { ok: true, run_id: target, status: result.status ?? "stopping" };
  }

  private hermesRequestOptions(): { signal: AbortSignal; sessionKey?: string } {
    return { signal: this.abort.signal, ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}) };
  }

  private isPushToTalkFallbackActive(): boolean {
    return (
      this.deps.config.realtime.provider === "openai" &&
      this.deps.config.openai.turnDetection === "disabled"
    );
  }

  private resolveActiveRunIdOrThrow(requestedRunId: string | undefined): string {
    if (!this.activeRunId) {
      throw new Error("No active agent run.");
    }
    if (requestedRunId && requestedRunId !== this.activeRunId) {
      throw new Error("Requested agent run is not active in this voice session.");
    }
    return this.activeRunId;
  }

  // Never throws; sibling of resolveActiveRunIdOrThrow for status/stop paths.
  private resolveRunIdTolerant(
    requestedRunId: string | undefined,
  ): { ok: true; runId: string } | { ok: false; result: Record<string, unknown> } {
    if (requestedRunId && requestedRunId !== this.activeRunId) {
      return {
        ok: false,
        result: {
          ok: false,
          error: "That run is no longer active.",
          active_run_id: this.activeRunId ?? null,
        },
      };
    }
    if (!this.activeRunId) {
      if (this.runStats) {
        return {
          ok: false,
          result: {
            ok: false,
            error: "No active agent run.",
            last_run: {
              run_id: this.runStats.runId,
              elapsed_s: (Date.now() - this.runStats.startedAt) / 1000,
              tools_started: this.runStats.toolsStarted,
              tools_completed: this.runStats.toolsCompleted,
              last_activity: this.runStats.lastReasoning ?? this.runStats.lastEventName,
            },
          },
        };
      }
      return { ok: false, result: { ok: false, error: "No active agent run." } };
    }
    return { ok: true, runId: this.activeRunId };
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
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    // OpenAI-style errors: {type:"error", error:{message:"..."}}
    if (typeof e.error === "object" && e.error !== null) {
      const inner = e.error as Record<string, unknown>;
      if (typeof inner.message === "string") return inner.message;
    }
    // Gemini-style: {error:{message:"..."}}
    if (typeof e.message === "string") return e.message;
    // Fallback: stringify the whole thing
    try {
      return JSON.stringify(error);
    } catch {
      // ignore
    }
  }
  return String(error);
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

function numberArg(call: LiveToolCall, name: string): number | undefined {
  const value = call.args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function randomIntInRange(min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}
