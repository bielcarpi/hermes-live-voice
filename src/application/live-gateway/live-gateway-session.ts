import { createHash, randomUUID } from "node:crypto";
import { errorToMessage } from "../../domain/error-message.js";
import { isPcmMimeType, requirePcmSampleRate } from "../../domain/audio/pcm.js";
import { makeSessionKey, type AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import {
  parseClientMessage,
  type ClientMessage,
  type RealtimeResponseTruncation,
} from "../../domain/protocol/client-protocol.js";
import {
  serverMessage,
  type HermesApprovalDetails,
  type HermesRunEvent,
  type ServerMessage,
} from "../../domain/protocol/server-protocol.js";
import { HERMES_LIVE_PROTOCOL_VERSION } from "../../domain/protocol/version.js";
import { realtimeClientCapabilities } from "./client-capabilities.js";
import { HERMES_TARGETED_APPROVAL_FEATURE } from "./hermes-approval-compatibility.js";
import type { ClientConnectionPort, ClientInboundFrame } from "./ports/client-connection.port.js";
import type { HermesRunsPort } from "./ports/hermes-runs.port.js";
import {
  type LiveModelEvent,
  type LiveToolCall,
  type LiveModelAdapter,
  type LiveModelSession,
} from "./ports/realtime-model.port.js";
import { buildSystemInstruction } from "./system-instruction.js";

const MAX_PENDING_APPROVALS = 128;
const MAX_PROCESSED_APPROVAL_RESPONSES = 256;
const MAX_PENDING_PROVIDER_EVENTS = 256;
const MAX_PENDING_PROVIDER_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_TRANSCRIPT_CHARS = 20_000;
const MAX_HERMES_OUTPUT_CHARS = 200_000;
const MAX_PUBLIC_RUN_EVENT_BYTES = 256_000;
const MAX_PUBLIC_USAGE_BYTES = 64_000;
const MAX_RUN_START_CLOSE_WAIT_MS = 5_000;
const MAX_PROVIDER_CANCEL_WAIT_MS = 1_000;
const MAX_PROVIDER_IO_WAIT_MS = 10_000;
const MAX_PENDING_CLIENT_MESSAGES = 256;
const MAX_PENDING_CLIENT_BYTES = 8 * 1024 * 1024;
const MAX_CLIENT_MESSAGE_ERRORS = 16;
const MAX_PENDING_PROVIDER_TOOL_CALLS = 32;
const MAX_CONCURRENT_PROVIDER_TOOL_CALLS = 4;
const MAX_PROCESSED_PROVIDER_TOOL_CALLS = 256;
const MAX_PROVIDER_TOOL_CALL_ARGS_BYTES = 100_000;
const MAX_PROVIDER_TOOL_RESPONSE_BYTES = 256_000;
const MAX_CACHED_PROVIDER_TOOL_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_LEGACY_APPROVALS_RESOLVED = 10_000;

export interface LiveGatewaySessionDeps {
  config: AppConfig;
  hermes: HermesRunsPort;
  liveModel: LiveModelAdapter;
  logger: Logger;
}

interface PendingApprovalEnvelope {
  runId: string;
  approval: HermesApprovalDetails;
  sourceApprovalId: string;
  sourceKey: string;
  semanticFingerprint: string;
}

interface ProcessedApprovalResponse {
  fingerprint: string;
  response: Extract<ServerMessage, { type: "approval.responded" }>;
}

interface ProviderToolCallRecord {
  fingerprint: string;
  name: string;
  state: "pending" | "done";
  response?: Record<string, unknown>;
  responseBytes?: number;
  replayUnavailable?: boolean;
  replayPending?: boolean;
  startMarkerActive?: boolean;
}

export class LiveGatewaySession {
  private readonly id = `live_${randomUUID().replaceAll("-", "")}`;
  private readonly abort = new AbortController();
  private liveSession?: LiveModelSession;
  private starting = false;
  private closing = false;
  private sessionKey?: string;
  private hermesApprovalResponseByIdSupported = false;
  private profileId = "default";
  private userLabel = "anonymous";
  private activeRunId: string | undefined;
  private hermesRunActive = false;
  private pendingApprovals: PendingApprovalEnvelope[] = [];
  private readonly processedApprovalResponses = new Map<string, ProcessedApprovalResponse>();
  private readonly processedApprovalSources = new Map<string, string>();
  private readonly stopRequestedRunIds = new Set<string>();
  private readonly stopIntentRunIds = new Set<string>();
  private readonly stopNotificationRunIds = new Set<string>();
  private readonly stopRunOperations = new Map<
    string,
    Promise<Awaited<ReturnType<HermesRunsPort["stopRun"]>>>
  >();
  private approvalSubmissionInFlight = false;
  private deferredProviderTerminal?: Extract<LiveModelEvent, { type: "response" }>;
  private pendingRunStart?: Promise<Awaited<ReturnType<HermesRunsPort["startRun"]>>>;
  private runStartController?: AbortController;
  private pendingLiveConnect?: Promise<LiveModelSession>;
  private readonly providerCloseOperations = new WeakMap<LiveModelSession, Promise<boolean>>();
  private readonly pendingProviderCleanupOperations = new WeakMap<Promise<LiveModelSession>, Promise<boolean>>();
  private closePromise?: Promise<void>;
  private clientClosePromise?: Promise<void>;
  private requestedClientClose?: { code: number; reason: string; requestId?: string };
  private sessionShutdownUnconfirmed = false;
  private readonly runContainmentOperations = new Map<string, Promise<void>>();
  private messageQueue: Promise<void> = Promise.resolve();
  private pendingClientMessages = 0;
  private pendingClientBytes = 0;
  private clientInputOverflowed = false;
  private clientMessageErrors = 0;
  private readonly providerToolCalls = new Map<string, ProviderToolCallRecord>();
  private readonly providerToolOperations: Array<() => Promise<void>> = [];
  private activeProviderToolOperations = 0;
  private pendingProviderToolCalls = 0;
  private pendingStartToolCalls = 0;
  private cachedProviderToolResponseBytes = 0;

  constructor(
    private readonly client: ClientConnectionPort,
    private readonly deps: LiveGatewaySessionDeps,
  ) {}

  bind(): void {
    this.client.onMessage((data) => {
      if (this.closing || this.clientInputOverflowed) return;
      const bytes = clientInboundFrameBytes(data);
      if (
        this.pendingClientMessages >= MAX_PENDING_CLIENT_MESSAGES ||
        this.pendingClientBytes + bytes > MAX_PENDING_CLIENT_BYTES
      ) {
        this.clientInputOverflowed = true;
        this.fail(
          "client_input_backpressure",
          new Error("Client sent messages faster than the realtime session could process them."),
          false,
        );
        void this.closeClientAfterCleanup(1009, "client input backpressure");
        return;
      }
      let message: ClientMessage;
      let requestId: string | undefined;
      try {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        const parsed = JSON.parse(text) as unknown;
        requestId = requestIdFromUnknown(parsed);
        message = parseClientMessage(parsed);
      } catch (error) {
        this.handleClientMessageFailure(error, requestId);
        return;
      }
      this.pendingClientMessages += 1;
      this.pendingClientBytes += bytes;
      const processMessage = async () => {
        try {
          if (!this.clientInputOverflowed && !this.closing) {
            await this.handleClientMessage(message);
            this.clientMessageErrors = 0;
          }
        } catch (error) {
          this.handleClientMessageFailure(error, message.id);
        } finally {
          this.pendingClientMessages -= 1;
          this.pendingClientBytes -= bytes;
        }
      };
      if (isPreemptiveClientControl(message, Boolean(this.liveSession))) {
        void processMessage();
      } else {
        this.messageQueue = this.messageQueue.then(processMessage);
      }
    });
    this.client.onClose(() => {
      void this.close();
    });
    this.client.onError((error) => {
      this.deps.logger.warn("client connection error", { sessionId: this.id, error: String(error) });
    });
  }

  async start(message: Extract<ClientMessage, { type: "session.start" }>): Promise<void> {
    if (message.protocolVersion !== HERMES_LIVE_PROTOCOL_VERSION) {
      this.fail(
        "unsupported_protocol_version",
        new Error(
          `Hermes Live protocol version ${message.protocolVersion} is not supported; use ${HERMES_LIVE_PROTOCOL_VERSION}.`,
        ),
        false,
        message.id,
      );
      return;
    }
    if (this.liveSession || this.starting) {
      this.fail("session_already_started", new Error("Realtime session is already started."), true, message.id);
      return;
    }

    this.starting = true;
    let liveSession: LiveModelSession | undefined;
    let clearProviderReadyTimeout = () => {};
    let startupPhase: "hermes" | "realtime" = "hermes";
    try {
      this.profileId = this.deps.config.server.trustClientIdentity
        ? message.profileId ?? this.deps.config.server.defaultProfileId
        : this.deps.config.server.defaultProfileId;
      this.userLabel = this.deps.config.server.trustClientIdentity
        ? message.userLabel ?? this.deps.config.server.defaultUserLabel
        : this.deps.config.server.defaultUserLabel;
      this.sessionKey = makeSessionKey(this.deps.config.server.sessionPrefix, this.profileId, this.userLabel);
      const capabilities = await this.deps.hermes.assertRunsSupported(this.abort.signal);
      this.hermesApprovalResponseByIdSupported =
        capabilities.features?.[HERMES_TARGETED_APPROVAL_FEATURE] === true;
      startupPhase = "realtime";
      const pendingEvents: LiveModelEvent[] = [];
      let pendingEventBytes = 0;
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
        if (
          readySent ||
          providerStartupFailed ||
          providerReadyTimedOut ||
          !providerOpen ||
          !this.liveSession ||
          this.closing
        ) {
          return;
        }
        clearProviderReadyTimeout();
        const hermesInfo = publicHermesCapabilities(capabilities);
        this.send({
          type: "session.ready",
          protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
          sessionId: this.id,
          model: this.deps.config.realtime.model,
          hermes: hermesInfo,
          realtime: realtimeClientCapabilities(this.deps.config),
        });
        readySent = true;
        resolveProviderReady();
        for (const event of pendingEvents.splice(0)) {
          this.dispatchLiveModelEvent(event);
        }
        pendingEventBytes = 0;
      };
      const connect = this.deps.liveModel.connect({
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
            this.deps.logger.info("realtime provider session closed", {
              sessionId: this.id,
              ...providerCloseLogDetail(event),
            });
            if (this.closing) return;
            const closeDetail = publicProviderCloseEvent(event);
            this.send({
              type: "log",
              level: "info",
              message: "Realtime provider session closed",
              ...(closeDetail ? { data: closeDetail } : {}),
            });
            this.fail("realtime_provider_closed", new Error("Realtime provider session closed."), true);
            void this.closeClientAfterCleanup(1011, "realtime provider closed");
          },
          onError: (error) => {
            if (failProviderStartup(error)) {
              return;
            }
            this.deps.logger.warn("realtime provider reported an error", {
              sessionId: this.id,
              error: errorToMessage(error),
            });
            if (this.closing) return;
            this.fail(
              "realtime_provider_error",
              new Error("Realtime provider reported an error. Check the gateway logs."),
              true,
            );
          },
          onEvent: (event) => {
            if (this.closing) return;
            if (!readySent) {
              const eventBytes = safeJsonByteLength(event);
              if (
                pendingEvents.length >= MAX_PENDING_PROVIDER_EVENTS ||
                !Number.isFinite(eventBytes) ||
                eventBytes > MAX_PENDING_PROVIDER_EVENT_BYTES - pendingEventBytes
              ) {
                failProviderStartup(new Error("Realtime provider exceeded the safe pre-ready event queue limit."));
                return;
              }
              pendingEvents.push(event);
              pendingEventBytes += eventBytes;
              return;
            }
            this.dispatchLiveModelEvent(event);
          },
        },
      });
      this.pendingLiveConnect = connect;
      void connect.catch(() => {
        if (this.pendingLiveConnect === connect) this.pendingLiveConnect = undefined;
      });
      liveSession = await Promise.race([connect, providerReadyDeadline, providerReadyFailure]);
      if (this.pendingLiveConnect === connect) this.pendingLiveConnect = undefined;
      if (this.closing) {
        clearProviderReadyTimeout();
        await this.closeProviderSessionWithinDeadline(liveSession, "session close during realtime startup");
        return;
      }
      this.liveSession = liveSession;
      sendReady();
      await Promise.race([providerReady, providerReadyDeadline, providerReadyFailure]);
    } catch (error) {
      clearProviderReadyTimeout();
      const startupCleanupDeadlineMs = this.providerStartupCleanupDeadlineMs();
      let providerCleanupConfirmed = liveSession
        ? await this.closeProviderSessionWithinDeadline(
            liveSession,
            "realtime startup failure",
            startupCleanupDeadlineMs,
          )
        : true;
      const pendingConnect = this.pendingLiveConnect;
      if (pendingConnect) {
        providerCleanupConfirmed = (
          await this.closePendingProviderConnectWithinDeadline(
            pendingConnect,
            "realtime startup failure",
            startupCleanupDeadlineMs,
          )
        ) && providerCleanupConfirmed;
      }
      if (liveSession && this.liveSession === liveSession) {
        this.liveSession = undefined;
      }
      if (!this.closing) {
        this.deps.logger.warn("live session startup failed", {
          sessionId: this.id,
          phase: startupPhase,
          error: errorToMessage(error),
        });
        this.fail(
          "session_start_failed",
          new Error(
            startupPhase === "hermes"
              ? "Hermes API readiness check failed. Check the gateway logs."
              : publicRealtimeStartupError(error),
          ),
          providerCleanupConfirmed,
          message.id,
        );
        if (!providerCleanupConfirmed) {
          await this.closeClientAfterCleanup(1011, "realtime provider startup cleanup unconfirmed", message.id);
        }
      }
    } finally {
      this.starting = false;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private closeClientAfterCleanup(code: number, reason: string, requestId?: string): Promise<void> {
    const correlatedRequestId = requestId ?? this.requestedClientClose?.requestId;
    const requested = { code, reason, ...(correlatedRequestId ? { requestId: correlatedRequestId } : {}) };
    if (
      !this.requestedClientClose ||
      clientCloseSeverity(requested.code) > clientCloseSeverity(this.requestedClientClose.code)
    ) {
      this.requestedClientClose = requested;
    } else if (requestId && !this.requestedClientClose.requestId) {
      this.requestedClientClose.requestId = requestId;
    }
    if (this.clientClosePromise) return this.clientClosePromise;
    this.clientClosePromise = (async () => {
      await this.close();
      const outcome = this.requestedClientClose ?? requested;
      if (this.sessionShutdownUnconfirmed) {
        this.send({
          type: "session.error",
          code: "session_shutdown_unconfirmed",
          message: "The gateway could not confirm complete session shutdown. Verify any active task state in Hermes.",
          recoverable: false,
          ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
        });
        this.client.close(1011, "session shutdown unconfirmed");
        return;
      }
      this.client.close(outcome.code, outcome.reason);
    })();
    return this.clientClosePromise;
  }

  private async performClose(): Promise<void> {
    this.clearPendingApprovals();
    this.deferredProviderTerminal = undefined;
    this.providerToolOperations.length = 0;
    if (this.approvalSubmissionInFlight) {
      this.sessionShutdownUnconfirmed = true;
      this.deps.logger.error("approval submission was still in flight while closing the voice session", {
        sessionId: this.id,
        runId: this.activeRunId,
      });
    }
    const providerClose = this.closeProviderResourcesForSessionClose();
    this.abort.abort();
    const pendingStart = this.pendingRunStart;
    let startedDuringCloseRunId: string | undefined;
    if (pendingStart) {
      let startRejected = false;
      const observedStart = pendingStart.then(
        (started) => {
          startedDuringCloseRunId = started.runId;
          return started;
        },
        (error) => {
          startRejected = true;
          throw error;
        },
      );
      const settled = await settlesWithin(
        observedStart,
        Math.min(this.deps.config.hermes.timeoutMs, MAX_RUN_START_CLOSE_WAIT_MS),
      );
      if (!settled) {
        this.sessionShutdownUnconfirmed = true;
        this.deps.logger.error("Hermes run start did not settle before session close deadline", {
          sessionId: this.id,
        });
        void pendingStart
          .then((started) => this.stopLateStartedRun(started.runId))
          .catch(() => undefined);
        this.runStartController?.abort(new Error("Voice session closed before Hermes returned a run id."));
      } else if (startRejected) {
        this.sessionShutdownUnconfirmed = true;
        this.deps.logger.error("Hermes run start rejected while session close was in progress", {
          sessionId: this.id,
        });
      }
    }
    const ownedRunId = this.activeRunId ?? startedDuringCloseRunId;
    if (ownedRunId && !this.stopRequestedRunIds.has(ownedRunId)) {
      const runId = ownedRunId;
      try {
        await this.stopOwnedRunForClose(runId);
      } catch (error) {
        this.sessionShutdownUnconfirmed = true;
        this.deps.logger.error("failed to stop owned Hermes run while closing", {
          sessionId: this.id,
          runId,
          error: errorToMessage(error),
        });
      }
    }
    await providerClose;
  }

  private async closeProviderResourcesForSessionClose(): Promise<void> {
    const operations: Promise<unknown>[] = [];
    if (this.liveSession) {
      operations.push(this.closeProviderSessionWithinDeadline(this.liveSession, "voice session close"));
    }

    const pendingConnect = this.pendingLiveConnect;
    if (pendingConnect) {
      operations.push(this.closePendingProviderConnectWithinDeadline(
        pendingConnect,
        "voice session close",
        this.providerStartupCleanupDeadlineMs(),
      ));
    }

    await Promise.all(operations);
  }

  private closePendingProviderConnectWithinDeadline(
    pendingConnect: Promise<LiveModelSession>,
    context: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const existing = this.pendingProviderCleanupOperations.get(pendingConnect);
    if (existing) return existing;
    const lateCleanup = pendingConnect.then(
      (session) => this.closeProviderSessionWithinDeadline(session, `late connection after ${context}`, timeoutMs),
      () => true,
    ).finally(() => {
      if (this.pendingLiveConnect === pendingConnect) this.pendingLiveConnect = undefined;
    });
    const operation = withDeadline(
      lateCleanup,
      timeoutMs,
      "Realtime provider connection and cleanup did not settle before the safety deadline.",
    ).then(
      (confirmed) => confirmed,
      (error) => {
        this.sessionShutdownUnconfirmed = true;
        this.deps.logger.error("failed to confirm pending realtime provider connection cleanup", {
          sessionId: this.id,
          context,
          error: errorToMessage(error),
        });
        return false;
      },
    );
    this.pendingProviderCleanupOperations.set(pendingConnect, operation);
    return operation;
  }

  private closeProviderSessionWithinDeadline(
    session: LiveModelSession,
    context: string,
    timeoutMs = MAX_RUN_START_CLOSE_WAIT_MS,
  ): Promise<boolean> {
    const existing = this.providerCloseOperations.get(session);
    if (existing) return existing;
    const operation = withDeadline(
      Promise.resolve().then(() => session.close()),
      timeoutMs,
      "Realtime provider session close did not settle before the safety deadline.",
    ).then(
      () => true,
      (error) => {
        this.sessionShutdownUnconfirmed = true;
        this.deps.logger.error("failed to confirm realtime provider session close", {
          sessionId: this.id,
          context,
          error: errorToMessage(error),
        });
        return false;
      },
    );
    this.providerCloseOperations.set(session, operation);
    return operation;
  }

  private providerStartupCleanupDeadlineMs(): number {
    return Math.max(
      1,
      Math.min(this.deps.config.server.providerReadyTimeoutMs, MAX_RUN_START_CLOSE_WAIT_MS),
    );
  }

  private async stopOwnedRunForClose(runId: string): Promise<void> {
    if (this.stopRequestedRunIds.has(runId)) return;
    const pending = this.stopRunOperations.get(runId);
    if (pending) {
      const settled = await settlesWithin(
        pending,
        Math.max(1, Math.min(this.deps.config.hermes.timeoutMs, 5_000)),
      );
      if (settled) {
        try {
          await pending;
          return;
        } catch {
          // Retry below with a detached deadline if the session-scoped request was aborted.
        }
      } else {
        if (this.stopRunOperations.get(runId) === pending) {
          this.stopRunOperations.delete(runId);
        }
        this.deps.logger.error("Hermes stop request did not settle before the session close deadline", {
          sessionId: this.id,
          runId,
        });
      }
    }
    if (this.stopRequestedRunIds.has(runId)) return;
    const deadlineMs = Math.max(1, Math.min(this.deps.config.hermes.timeoutMs, 5_000));
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Hermes stop deadline exceeded while closing the voice session.")),
      deadlineMs,
    );
    timeout.unref?.();
    try {
      await withDeadline(
        this.requestHermesStop(runId, {
          signal: controller.signal,
          ...this.hermesDetachedRequestOptions(),
        }),
        deadlineMs,
        "Hermes stop request did not settle before the session close deadline.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async stopLateStartedRun(runId: string): Promise<void> {
    try {
      await this.stopOwnedRunForClose(runId);
    } catch (error) {
      this.deps.logger.error("failed to stop Hermes run that started after session close deadline", {
        sessionId: this.id,
        runId,
        error: errorToMessage(error),
      });
    }
  }

  private async handleClientMessage(message: ClientMessage): Promise<void> {
    if (message.type === "session.start") {
      await this.start(message);
      return;
    }
    if (message.type === "session.close") {
      await this.closeClientAfterCleanup(1000, "session closed", message.id);
      return;
    }
    if (!this.liveSession) {
      this.fail("session_not_started", new Error("Send session.start before streaming input."), true, message.id);
      return;
    }
    switch (message.type) {
      case "audio.input":
        validateAudioFrame(message.data, message.mimeType, this.deps.config.server.maxAudioBytes);
        await this.forwardRealtimeClientInput(
          "audio",
          () => this.liveSession!.sendRealtimeAudio({ data: message.data, mimeType: message.mimeType }),
        );
        break;
      case "audio.end":
        await this.forwardRealtimeClientInput("audio turn", () => this.liveSession!.sendAudioStreamEnd());
        break;
      case "text.input":
        validateText(message.text, this.deps.config.server.maxTextChars, "Text input");
        await this.forwardRealtimeClientInput("text", () => this.liveSession!.sendText(message.text));
        break;
      case "response.cancel":
        await this.cancelRealtimeResponse(message.reason, message.truncate);
        break;
      case "approval.respond":
        await this.handleApprovalResponse(message);
        break;
      case "run.stop":
        {
          const stopOperation = this.stopRun(message.runId, message.reason);
          void this.cancelRealtimeResponse(message.reason);
          await stopOperation;
        }
        break;
    }
  }

  private async executeToolCall(call: LiveToolCall): Promise<Record<string, unknown>> {
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
        return await this.startHermesRun(message, recentContext);
      }
      case "get_hermes_run_status": {
        const runId = this.resolveActiveRunId(stringArg(call, "run_id") || undefined);
        try {
          const status = await this.deps.hermes.getRun(runId, this.hermesRequestOptions());
          assertHermesResponseRunCorrelation(status, runId, "status");
          return { ok: true, status: publicHermesRunStatus(status, runId) };
        } catch (error) {
          this.deps.logger.warn("failed to read Hermes run status", {
            sessionId: this.id,
            runId,
            error: errorToMessage(error),
          });
          throw new Error("Hermes run status could not be read. Check the gateway logs.");
        }
      }
      case "stop_hermes_run": {
        const runId = stringArg(call, "run_id") || this.activeRunId;
        return await this.stopRun(runId, stringArg(call, "reason"));
      }
      default:
        return { ok: false, error: `Unknown hermes-live tool: ${call.name}` };
    }
  }

  private enqueueProviderToolCall(call: LiveToolCall): void {
    let id: string;
    let fingerprint: string;
    try {
      id = requireProviderToolCallId(call);
      fingerprint = providerToolCallFingerprint(call);
    } catch (error) {
      this.fail("tool_call_failed", error, false);
      void this.closeClientAfterCleanup(1011, "invalid realtime tool call");
      return;
    }

    const existing = this.providerToolCalls.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.fail(
          "realtime_tool_call_conflict",
          new Error("Realtime provider reused a tool-call id for different tool data."),
          false,
        );
        void this.closeClientAfterCleanup(1011, "conflicting realtime tool call");
        return;
      }
      if (existing.state === "done" && !existing.response) {
        this.fail(
          "realtime_tool_replay_unavailable",
          new Error("A duplicate realtime tool call could not be replayed safely."),
          false,
        );
        void this.closeClientAfterCleanup(1011, "realtime tool replay unavailable");
        return;
      }
      if (existing.state === "done" && existing.response && !existing.replayPending) {
        if (this.pendingProviderToolCalls >= MAX_PENDING_PROVIDER_TOOL_CALLS) {
          this.failProviderToolQueueOverflow();
          return;
        }
        existing.replayPending = true;
        this.pendingProviderToolCalls += 1;
        this.scheduleProviderToolOperation(async () => {
          try {
            await this.sendProviderToolResponse(call, existing.response!);
          } finally {
            existing.replayPending = false;
            this.pendingProviderToolCalls -= 1;
          }
        });
      }
      return;
    }

    if (this.pendingProviderToolCalls >= MAX_PENDING_PROVIDER_TOOL_CALLS) {
      this.failProviderToolQueueOverflow();
      return;
    }
    if (this.providerToolCalls.size >= MAX_PROCESSED_PROVIDER_TOOL_CALLS) {
      this.failProviderToolQueueOverflow();
      return;
    }

    const record: ProviderToolCallRecord = {
      fingerprint,
      name: call.name,
      state: "pending",
      ...(call.name === "start_hermes_run" ? { startMarkerActive: true } : {}),
    };
    this.providerToolCalls.set(id, record);
    this.pendingProviderToolCalls += 1;
    if (call.name === "start_hermes_run") this.pendingStartToolCalls += 1;
    this.scheduleProviderToolOperation(async () => {
      let response: Record<string, unknown>;
      try {
        response = await this.executeToolCall(call);
      } catch (error) {
        const publicError = boundedText(errorToMessage(error), 2_000);
        response = { ok: false, error: publicError };
        this.fail("tool_call_failed", new Error(publicError), true);
      }
      response = boundedProviderToolResponse(response);
      const responseBytes = safeJsonByteLength(response);
      if (responseBytes <= MAX_CACHED_PROVIDER_TOOL_RESPONSE_BYTES - this.cachedProviderToolResponseBytes) {
        record.response = response;
        record.responseBytes = responseBytes;
        this.cachedProviderToolResponseBytes += responseBytes;
      } else {
        record.replayUnavailable = true;
      }
      record.state = "done";
      try {
        await this.sendProviderToolResponse(call, response);
      } finally {
        this.pendingProviderToolCalls -= 1;
        if (call.name === "start_hermes_run") {
          this.releaseProviderStartMarker(record);
        }
      }
    });
  }

  private handleLiveModelEvent(event: LiveModelEvent): void {
    if (event.type === "audio") {
      validateAudioFrame(event.audio.data, event.audio.mimeType, this.deps.config.server.maxAudioBytes);
      const itemId = publicProviderIdentifier(event.audio.itemId);
      const contentIndex = publicContentIndex(event.audio.contentIndex);
      this.send({
        type: "audio.output",
        data: event.audio.data,
        mimeType: event.audio.mimeType,
        ...(itemId ? { itemId } : {}),
        ...(contentIndex === undefined ? {} : { contentIndex }),
      });
    } else if (event.type === "text") {
      if (event.text.length > MAX_PROVIDER_TRANSCRIPT_CHARS) {
        throw new Error(`Realtime provider transcript delta exceeds ${MAX_PROVIDER_TRANSCRIPT_CHARS} characters.`);
      }
      this.send({
        type: "transcript.delta",
        speaker: event.speaker ?? "assistant",
        text: event.text,
        ...(event.final === undefined ? {} : { final: event.final }),
      });
    } else if (event.type === "tool_call") {
      this.enqueueProviderToolCall(event.call);
    } else if (event.type === "input_speech_started") {
      const itemId = publicProviderIdentifier(event.itemId);
      const audioStartMs = publicAudioStartMs(event.audioStartMs);
      this.send({
        type: "input.speech_started",
        provider: event.provider,
        ...(itemId ? { itemId } : {}),
        ...(audioStartMs === undefined ? {} : { audioStartMs }),
      });
    } else if (event.type === "response") {
      if (
        event.status !== "started" &&
        (this.hermesRunActive || this.pendingStartToolCalls > 0) &&
        !this.activeRunId
      ) {
        this.deferredProviderTerminal = event;
        return;
      }
      if (event.status === "failed") {
        this.deps.logger.warn("realtime provider response failed", {
          sessionId: this.id,
          error: boundedText(event.error ?? "Realtime response failed.", 2_000),
        });
        const responseId = publicProviderIdentifier(event.responseId);
        this.send({
          type: "response.failed",
          ...(responseId ? { responseId } : {}),
          error: "Realtime provider response failed. Check the gateway logs.",
        });
      } else {
        const boundedResponseId = publicProviderIdentifier(event.responseId);
        const responseId = boundedResponseId ? { responseId: boundedResponseId } : {};
        if (event.status === "started") this.send({ type: "response.started", ...responseId });
        else if (event.status === "completed") this.send({ type: "response.completed", ...responseId });
        else this.send({ type: "response.cancelled", ...responseId });
      }
    }
  }

  private dispatchLiveModelEvent(event: LiveModelEvent): void {
    if (this.closing) return;
    try {
      this.handleLiveModelEvent(event);
    } catch (error) {
      this.fail(
        "realtime_provider_event_invalid",
        new Error(`Realtime provider emitted an invalid event: ${errorToMessage(error)}`),
        false,
      );
      void this.closeClientAfterCleanup(1011, "invalid realtime provider event");
    }
  }

  private async startHermesRun(message: string, recentVoiceContext?: string): Promise<Record<string, unknown>> {
    if (!this.sessionKey) {
      throw new Error("session.start has not completed.");
    }
    if (this.hermesRunActive) {
      return { ok: false, error: "A Hermes run is already active for this voice session." };
    }
    if (this.closing) {
      return { ok: false, error: "The voice session is closing and cannot start another Hermes run." };
    }

    this.clearPendingApprovals();
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
      const runStartController = new AbortController();
      this.runStartController = runStartController;
      const pendingStart = this.deps.hermes.startRun(runParams, runStartController.signal).then((started) => {
        if (!isRecordValue(started) || !isBoundedRunId(started.runId)) {
          throw new Error("Hermes returned an invalid run start response.");
        }
        const normalized = {
          runId: started.runId,
          status: typeof started.status === "string" && started.status.length <= 128
            ? started.status
            : "started",
        };
        this.activeRunId = normalized.runId;
        return normalized;
      });
      this.pendingRunStart = pendingStart;
      let started: Awaited<typeof pendingStart>;
      try {
        started = await pendingStart;
      } finally {
        if (this.pendingRunStart === pendingStart) this.pendingRunStart = undefined;
        if (this.runStartController === runStartController) this.runStartController = undefined;
      }
      runId = started.runId;
      if (this.closing) {
        return { ok: false, run_id: runId, status: "cancelled" };
      }
      this.send({ type: "run.started", runId, sessionId: this.id });
      this.releaseOldestProviderStartMarker();

      let transcript = "";
      let finalOutput = "";
      let usage: Record<string, unknown> | undefined;

      for await (const event of this.deps.hermes.streamRunEvents(runId, this.hermesRequestOptions())) {
        assertHermesRunEventCorrelation(event, runId);
        await this.forwardRunEvent(runId, event);
        if (this.closing || this.abort.signal.aborted) {
          return { ok: false, run_id: runId, status: "cancelled", output: transcript };
        }
        if (event.event === "message.delta" && typeof event.delta === "string") {
          transcript = appendBoundedText(transcript, event.delta, MAX_HERMES_OUTPUT_CHARS);
        } else if (event.event === "run.completed") {
          this.clearPendingApprovals(runId);
          finalOutput = boundedText(
            typeof event.output === "string" ? event.output : transcript,
            MAX_HERMES_OUTPUT_CHARS,
          );
          usage = boundedUsage(event.usage);
          this.send({
            type: "run.completed",
            runId,
            output: finalOutput || transcript,
            ...(usage ? { usage } : {}),
          });
          return { ok: true, run_id: runId, output: finalOutput || transcript, usage };
        } else if (event.event === "run.failed") {
          this.clearPendingApprovals(runId);
          this.deps.logger.warn("Hermes run reported failure", {
            sessionId: this.id,
            runId,
            error: String(event.error ?? "Hermes run failed."),
          });
          return {
            ok: false,
            run_id: runId,
            status: "failed",
            output: transcript,
            error: "Hermes run failed. Check the gateway logs for details.",
          };
        } else if (event.event === "run.cancelled") {
          this.clearPendingApprovals(runId);
          return { ok: false, run_id: runId, status: "cancelled" };
        }
      }

      const output = transcript;
      const error = "Hermes run event stream ended before a terminal event.";
      if (this.closing) {
        return { ok: false, run_id: runId, status: "cancelled", output };
      }
      await this.containBrokenRun(runId, error);
      return { ok: false, run_id: runId, status: "indeterminate", output, error };
    } catch (error) {
      if (!runId) this.sessionShutdownUnconfirmed = true;
      if (this.abort.signal.aborted || this.closing) {
        return {
          ok: false,
          ...(runId ? { run_id: runId } : {}),
          status: "cancelled",
        };
      }
      if (!runId) {
        this.deferredProviderTerminal = undefined;
        this.deps.logger.warn("Hermes run failed to start", {
          sessionId: this.id,
          error: errorToMessage(error),
        });
        this.fail(
          "hermes_run_start_outcome_indeterminate",
          new Error("Hermes did not confirm whether the run started. Verify task state in Hermes before retrying."),
          false,
        );
        await this.closeClientAfterCleanup(1011, "Hermes run start outcome indeterminate");
        return { ok: false, status: "indeterminate", error: "Hermes run start outcome could not be confirmed." };
      }
      this.deps.logger.warn("Hermes run bridge failed", { sessionId: this.id, runId, error: errorToMessage(error) });
      const publicMessage = "Hermes run failed. Check the gateway logs for details.";
      await this.containBrokenRun(runId, error);
      return { ok: false, run_id: runId, status: "indeterminate", error: publicMessage };
    } finally {
      if (runId) {
        this.clearPendingApprovals(runId);
        this.clearProcessedApprovalSources(runId);
      }
      this.hermesRunActive = false;
      if (runId && this.activeRunId === runId) {
        this.activeRunId = undefined;
      }
      if (runId && !this.closing) {
        this.stopRequestedRunIds.delete(runId);
        this.stopNotificationRunIds.delete(runId);
        this.stopIntentRunIds.delete(runId);
      }
    }
  }

  private containBrokenRun(runId: string, cause: unknown): Promise<void> {
    const existing = this.runContainmentOperations.get(runId);
    if (existing) return existing;
    const operation = this.performBrokenRunContainment(runId, cause);
    this.runContainmentOperations.set(runId, operation);
    return operation;
  }

  private async performBrokenRunContainment(runId: string, cause: unknown): Promise<void> {
    let stopRequested = false;
    try {
      await this.stopOwnedRunForClose(runId);
      stopRequested = true;
      this.clearPendingApprovals(runId);
    } catch (stopError) {
      this.deps.logger.error("Hermes run ownership became indeterminate", {
        sessionId: this.id,
        runId,
        cause: errorToMessage(cause),
        stopError: errorToMessage(stopError),
      });
    }
    this.fail(
      "hermes_run_outcome_indeterminate",
      new Error(
        stopRequested
          ? "Hermes run events ended unexpectedly. A stop was requested, and the session is closing until terminal state can be confirmed."
          : "Hermes run status could not be confirmed. The session is closing to prevent further work.",
      ),
      false,
    );
    await this.closeClientAfterCleanup(1011, "Hermes run outcome indeterminate");
  }

  private flushDeferredProviderTerminal(): void {
    const deferred = this.deferredProviderTerminal;
    if (!deferred) return;
    this.deferredProviderTerminal = undefined;
    if (this.closing) return;
    this.handleLiveModelEvent(deferred);
  }

  private async forwardRunEvent(runId: string, event: HermesRunEvent): Promise<void> {
    if (
      event.event === "approval.request" &&
      (
        this.stopIntentRunIds.has(runId) ||
        this.stopRequestedRunIds.has(runId) ||
        this.stopRunOperations.has(runId)
      )
    ) {
      return;
    }
    const publicEvent = publicHermesRunEvent(event, this.deps.config.server.runEventDetail);
    if (publicEvent) {
      this.send({ type: "run.event", runId, event: publicEvent });
    }
    if (event.event === "approval.request") {
      if (
        !this.hermesApprovalResponseByIdSupported ||
        !approvalSourceId(event.approval_id)
      ) {
        await this.denyUncorrelatedHermesApprovals(runId);
        return;
      }
      const envelope = this.trackPendingApproval(
        runId,
        event,
        publicEvent ?? publicHermesRunEvent(event, "summary")!,
      );
      if (envelope) this.send(envelope);
    } else if (event.event === "run.failed") {
      this.send({ type: "run.failed", runId, error: "Hermes run failed. Check the gateway logs for details." });
    } else if (event.event === "run.cancelled") {
      this.send({ type: "run.stopped", runId, status: "cancelled" });
    }
  }

  private async denyUncorrelatedHermesApprovals(runId: string): Promise<void> {
    // Crossing this boundary makes every outstanding approval for the run
    // unsafe to answer. Quarantine synchronously, before the first await, so a
    // client response cannot race the legacy deny-all request.
    this.stopIntentRunIds.add(runId);
    this.clearPendingApprovals(runId);
    let denialConfirmed = false;
    try {
      const result = await withAbortAndDeadline(
        this.deps.hermes.submitApproval(runId, "deny", {
          resolveAll: true,
          ...this.hermesRequestOptions(),
        }),
        this.abort.signal,
        this.deps.config.hermes.timeoutMs,
        "Hermes legacy approval denial did not settle before the safety deadline.",
      );
      if (!isRecordValue(result)) {
        throw new Error("Hermes did not confirm fail-closed denial of its uncorrelated approval queue.");
      }
      if (
        typeof result.resolved !== "number" ||
        !Number.isInteger(result.resolved) ||
        result.resolved < 1 ||
        result.resolved > MAX_LEGACY_APPROVALS_RESOLVED ||
        result.run_id !== runId ||
        (result.runId !== undefined && result.runId !== runId) ||
        result.choice !== "deny"
      ) {
        throw new Error("Hermes did not confirm fail-closed denial of its uncorrelated approval queue.");
      }
      denialConfirmed = true;
      this.deps.logger.warn("denied uncorrelated Hermes approval request", {
        sessionId: this.id,
        runId,
        resolved: result.resolved,
      });
    } catch (error) {
      if (this.closing || this.abort.signal.aborted) return;
      this.deps.logger.error("failed to confirm denial of uncorrelated Hermes approval request", {
        sessionId: this.id,
        runId,
        error: errorToMessage(error),
      });
    }

    if (this.closing || this.abort.signal.aborted) return;
    this.fail(
      "hermes_approval_identity_unsupported",
      new Error(
        denialConfirmed
          ? "Interactive approval is unavailable because this Hermes version cannot correlate requests safely. The pending queue was denied, the run is being stopped, and the voice session is closing. Verify the run in Hermes before retrying."
          : "Interactive approval is unavailable because this Hermes version cannot correlate requests safely, and denial could not be confirmed. The run is being stopped and the voice session is closing. Verify the run in Hermes before retrying.",
      ),
      false,
    );
    if (!denialConfirmed) this.sessionShutdownUnconfirmed = true;
    try {
      await this.stopOwnedRunForClose(runId);
    } catch (error) {
      this.sessionShutdownUnconfirmed = true;
      this.deps.logger.error("failed to stop run after uncorrelated Hermes approval request", {
        sessionId: this.id,
        runId,
        error: errorToMessage(error),
      });
    }
    await this.closeClientAfterCleanup(1011, "Hermes approval identity unsupported");
  }

  private async handleApprovalResponse(message: Extract<ClientMessage, { type: "approval.respond" }>): Promise<void> {
    if (message.resolveAll === true) {
      throw new Error("Bulk approval resolution is not supported; answer each approval in FIFO order.");
    }

    const fingerprint = approvalResponseFingerprint(message);
    const processed = this.processedApprovalResponses.get(message.id);
    if (processed) {
      if (processed.fingerprint !== fingerprint) {
        throw new Error("Approval response request id was already used for different approval data.");
      }
      if (this.approvalResponsesBlocked(processed.response.runId)) {
        throw new Error("The Hermes run is stopping and no longer accepts approval responses.");
      }
      this.send(processed.response);
      return;
    }
    const runId = this.resolveActiveRunId(message.runId);
    if (this.approvalResponsesBlocked(runId)) {
      throw new Error("The Hermes run is stopping and no longer accepts approval responses.");
    }
    if (this.approvalSubmissionInFlight) {
      throw new Error("An approval response is already being submitted; wait for its result.");
    }

    const pending = this.pendingApprovals[0];
    if (!pending || pending.runId !== runId) {
      throw new Error("No pending approval is available for the active Hermes run.");
    }
    if (pending.approval.approvalId !== message.approvalId) {
      throw new Error("Approval response does not match the oldest pending request.");
    }
    if (
      message.choice === "always" &&
      (!pending.approval.choices.includes("always") || !canApprovePermanently(pending.approval))
    ) {
      throw new Error("Permanent approval requires an inspectable permission pattern.");
    }
    if (!pending.approval.choices.includes(message.choice)) {
      throw new Error(`Approval choice ${message.choice} was not offered for the pending request.`);
    }

    this.approvalSubmissionInFlight = true;
    let result: Awaited<ReturnType<HermesRunsPort["submitApproval"]>>;
    try {
      result = await withAbortAndDeadline(
        this.deps.hermes.submitApproval(runId, message.choice, {
          approvalId: pending.sourceApprovalId,
          ...this.hermesRequestOptions(),
        }),
        this.abort.signal,
        this.deps.config.hermes.timeoutMs,
        "Hermes approval submission did not settle before the safety deadline.",
      );
    } catch (error) {
      if (this.approvalResponsesBlocked(runId)) {
        this.clearPendingApprovals(runId);
        return;
      }
      await this.failClosedApprovalSubmission(message, error);
      return;
    } finally {
      this.approvalSubmissionInFlight = false;
    }

    // A stop or uncorrelated approval may have quarantined the run while the
    // targeted mutation was in flight. The upstream result may be real, but it
    // must not be surfaced or cached as a positive acknowledgement after that
    // safety boundary.
    if (this.approvalResponsesBlocked(runId)) {
      this.clearPendingApprovals(runId);
      return;
    }

    if (!isRecordValue(result)) {
      await this.failClosedApprovalSubmission(
        message,
        new Error("Hermes returned a malformed approval response."),
      );
      return;
    }
    if (result.resolved !== 1) {
      await this.failClosedApprovalSubmission(
        message,
        new Error(`Hermes returned an invalid approval resolution count: ${String(result.resolved)}.`),
      );
      return;
    }
    if (
      !isBoundedRunId(result.run_id) ||
      result.run_id !== runId ||
      (result.runId !== undefined && (!isBoundedRunId(result.runId) || result.runId !== runId)) ||
      !approvalSourceKey(result.approval_id ?? result.approvalId) ||
      (result.approval_id !== undefined && result.approvalId !== undefined && result.approval_id !== result.approvalId) ||
      (result.approval_id ?? result.approvalId) !== pending.sourceApprovalId ||
      result.choice !== message.choice
    ) {
      await this.failClosedApprovalSubmission(
        message,
        new Error("Hermes returned approval correlation data that did not match the submitted response."),
      );
      return;
    }

    const current = this.pendingApprovals[0];
    if (
      current &&
      (current.runId !== runId || current.approval.approvalId !== message.approvalId)
    ) {
      await this.failClosedApprovalSubmission(
        message,
        new Error("Pending approval state changed while Hermes was processing the response."),
      );
      return;
    }
    if (current) {
      try {
        this.rememberProcessedApprovalSource(current);
      } catch (error) {
        await this.failClosedApprovalSubmission(message, error);
        return;
      }
      this.pendingApprovals.shift();
    }

    const response: Extract<ServerMessage, { type: "approval.responded" }> = {
      type: "approval.responded",
      requestId: message.id,
      runId,
      approvalId: message.approvalId,
      choice: message.choice,
      resolved: 1,
    };
    this.rememberApprovalResponse(message.id, fingerprint, response);
    this.send(response);
  }

  private approvalResponsesBlocked(runId: string): boolean {
    return this.closing ||
      this.abort.signal.aborted ||
      this.stopIntentRunIds.has(runId) ||
      this.stopRequestedRunIds.has(runId) ||
      this.stopRunOperations.has(runId);
  }

  private async failClosedApprovalSubmission(
    message: Extract<ClientMessage, { type: "approval.respond" }>,
    error: unknown,
  ): Promise<void> {
    this.deps.logger.error("approval outcome became indeterminate", {
      sessionId: this.id,
      runId: message.runId,
      approvalId: message.approvalId,
      error: errorToMessage(error),
    });
    this.clearPendingApprovals(message.runId);
    this.fail(
      "approval_outcome_indeterminate",
      new Error("Hermes approval outcome could not be confirmed. The run is being stopped and this session is closing."),
      false,
      message.id,
    );
    await this.closeClientAfterCleanup(1011, "approval outcome indeterminate");
  }

  private rememberApprovalResponse(
    requestId: string,
    fingerprint: string,
    response: Extract<ServerMessage, { type: "approval.responded" }>,
  ): void {
    if (this.processedApprovalResponses.size >= MAX_PROCESSED_APPROVAL_RESPONSES) {
      const oldest = this.processedApprovalResponses.keys().next().value;
      if (oldest) this.processedApprovalResponses.delete(oldest);
    }
    this.processedApprovalResponses.set(requestId, { fingerprint, response });
  }

  private async stopRun(runId: string | undefined, reason?: string): Promise<Record<string, unknown>> {
    const target = this.resolveActiveRunId(runId);
    this.stopIntentRunIds.add(target);
    this.clearPendingApprovals(target);
    let result: Awaited<ReturnType<HermesRunsPort["stopRun"]>>;
    try {
      result = await this.requestHermesStop(target, this.hermesRequestOptions());
    } catch (error) {
      if (this.activeRunId !== target || !this.hermesRunActive) {
        this.stopRequestedRunIds.delete(target);
        this.stopNotificationRunIds.delete(target);
        return { ok: true, run_id: target, status: "terminal" };
      }
      this.deps.logger.warn("Hermes run stop request failed", {
        sessionId: this.id,
        runId: target,
        error: errorToMessage(error),
      });
      await this.containBrokenRun(target, error);
      return { ok: false, run_id: target, status: "indeterminate" };
    }
    if (this.activeRunId !== target || !this.hermesRunActive) {
      this.stopRequestedRunIds.delete(target);
      this.stopNotificationRunIds.delete(target);
      return { ok: true, run_id: target, status: "terminal" };
    }
    if (!this.stopNotificationRunIds.has(target)) {
      this.stopNotificationRunIds.add(target);
      this.send({ type: "run.stopping", runId: target, status: publicRunStatus(result.status) });
      this.send({ type: "log", level: "info", message: "Hermes run stop requested", data: { runId: target, reason } });
    }
    return { ok: true, run_id: target, status: publicRunStatus(result.status) };
  }

  private requestHermesStop(
    runId: string,
    options: { signal?: AbortSignal; sessionKey?: string },
  ): Promise<Awaited<ReturnType<HermesRunsPort["stopRun"]>>> {
    if (this.stopRequestedRunIds.has(runId)) {
      return Promise.resolve({ run_id: runId, status: "stopping" });
    }
    const existing = this.stopRunOperations.get(runId);
    if (existing) return existing;

    let operation!: Promise<Awaited<ReturnType<HermesRunsPort["stopRun"]>>>;
    operation = (async () => {
      try {
        const rawResult: unknown = await this.deps.hermes.stopRun(runId, options);
        if (!isRecordValue(rawResult)) {
          throw new Error("Hermes returned a malformed stop response.");
        }
        if (
          rawResult.run_id !== runId ||
          rawResult.status !== "stopping" ||
          (rawResult.runId !== undefined && rawResult.runId !== runId)
        ) {
          throw new Error("Hermes returned an invalid stop confirmation.");
        }
        const result = { run_id: runId, status: "stopping" as const };
        this.stopRequestedRunIds.add(runId);
        return result;
      } finally {
        if (this.stopRunOperations.get(runId) === operation) {
          this.stopRunOperations.delete(runId);
        }
      }
    })();
    this.stopRunOperations.set(runId, operation);
    return operation;
  }

  private hermesRequestOptions(): { signal: AbortSignal; sessionKey?: string } {
    return { signal: this.abort.signal, ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}) };
  }

  private hermesDetachedRequestOptions(): { sessionKey?: string } {
    return this.sessionKey ? { sessionKey: this.sessionKey } : {};
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

  private trackPendingApproval(
    runId: string,
    event: HermesRunEvent,
    publicEvent: HermesRunEvent,
  ): Extract<ServerMessage, { type: "approval.request" }> | undefined {
    const sourceApprovalId = approvalSourceId(event.approval_id);
    if (!sourceApprovalId) {
      throw new Error("Hermes approval request did not include a bounded approval_id.");
    }
    const sourceKey = approvalSourceKey(sourceApprovalId);
    if (!sourceKey) {
      throw new Error("Hermes approval request did not include a valid approval_id.");
    }
    const projectedApproval = publicApprovalDetails(event, "pending");
    const semanticFingerprint = approvalSemanticFingerprint(projectedApproval);
    const processedKey = `${runId}:${sourceKey}`;
    const processedFingerprint = this.processedApprovalSources.get(processedKey);
    if (processedFingerprint) {
      if (processedFingerprint !== semanticFingerprint) {
        throw new Error("Hermes reused a resolved approval id for different approval semantics.");
      }
      return undefined;
    }
    const existingIndex = this.pendingApprovals.findIndex(
      (pending) => pending.runId === runId && pending.sourceKey === sourceKey,
    );
    const existing = existingIndex >= 0 ? this.pendingApprovals[existingIndex] : undefined;
    if (existing && existing.semanticFingerprint !== semanticFingerprint) {
      throw new Error("Hermes reused an approval id for different approval semantics.");
    }
    if (existing) return undefined;
    if (
      this.processedApprovalSources.size + this.pendingApprovals.length >=
      MAX_PROCESSED_APPROVAL_RESPONSES
    ) {
      throw new Error("Hermes exceeded the safe resolved approval correlation limit.");
    }
    const approvalId = `approval_${randomUUID().replaceAll("-", "")}`;
    const approval = { ...projectedApproval, approvalId };
    const envelope: Extract<ServerMessage, { type: "approval.request" }> = {
      type: "approval.request",
      runId,
      event: publicEvent,
      approval,
    };
    const pending: PendingApprovalEnvelope = {
      runId,
      approval,
      sourceApprovalId,
      sourceKey,
      semanticFingerprint,
    };
    if (this.pendingApprovals.length >= MAX_PENDING_APPROVALS) {
      throw new Error("Hermes exceeded the safe pending approval queue limit.");
    }
    this.pendingApprovals.push(pending);
    return envelope;
  }

  private clearPendingApprovals(runId?: string): void {
    if (!runId) {
      this.pendingApprovals = [];
      return;
    }
    this.pendingApprovals = this.pendingApprovals.filter((pending) => pending.runId !== runId);
  }

  private rememberProcessedApprovalSource(pending: PendingApprovalEnvelope): void {
    const key = `${pending.runId}:${pending.sourceKey}`;
    const existing = this.processedApprovalSources.get(key);
    if (existing && existing !== pending.semanticFingerprint) {
      throw new Error("Resolved approval correlation changed unexpectedly.");
    }
    if (!existing && this.processedApprovalSources.size >= MAX_PROCESSED_APPROVAL_RESPONSES) {
      throw new Error("Hermes exceeded the safe resolved approval correlation limit.");
    }
    this.processedApprovalSources.set(key, pending.semanticFingerprint);
  }

  private clearProcessedApprovalSources(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.processedApprovalSources.keys()) {
      if (key.startsWith(prefix)) this.processedApprovalSources.delete(key);
    }
  }

  private async cancelRealtimeResponse(reason?: string, truncate?: RealtimeResponseTruncation): Promise<void> {
    try {
      const cancelled = (await withDeadline(
        Promise.resolve(this.liveSession?.cancelResponse(reason, truncate) ?? false),
        MAX_PROVIDER_CANCEL_WAIT_MS,
        "Realtime provider cancellation did not settle before the safety deadline.",
      )) ?? false;
      if (this.closing) return;
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
      if (this.closing) return;
      this.send({ type: "log", level: "warn", message: "Realtime response cancellation failed", data: { reason } });
    }
  }

  private async forwardRealtimeClientInput(label: string, operation: () => Promise<void>): Promise<void> {
    try {
      await withAbortAndDeadline(
        operation(),
        this.abort.signal,
        MAX_PROVIDER_IO_WAIT_MS,
        `Realtime provider ${label} input did not settle before the safety deadline.`,
      );
    } catch (error) {
      if (this.closing || this.abort.signal.aborted) return;
      this.deps.logger.warn("realtime provider rejected client input", {
        sessionId: this.id,
        input: label,
        error: errorToMessage(error),
      });
      this.fail(
        "realtime_provider_input_failed",
        new Error(`Realtime provider could not safely confirm ${label} input. Check the gateway logs.`),
        false,
      );
      await this.closeClientAfterCleanup(1011, "realtime provider input failed");
    }
  }

  private async sendProviderToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    if (this.closing) return;
    try {
      if (!this.liveSession) throw new Error("Realtime provider session is unavailable.");
      await withAbortAndDeadline(
        this.liveSession.sendToolResponse(call, response),
        this.abort.signal,
        MAX_PROVIDER_IO_WAIT_MS,
        "Realtime provider tool response did not settle before the safety deadline.",
      );
    } catch (error) {
      if (this.closing) return;
      this.deps.logger.warn("failed to send realtime tool response", {
        sessionId: this.id,
        callId: call.id,
        error: errorToMessage(error),
      });
      this.fail(
        "realtime_tool_response_failed",
        new Error("Realtime provider could not accept the Hermes tool result. Check the gateway logs."),
        false,
      );
      await this.closeClientAfterCleanup(1011, "realtime tool response failed");
    }
  }

  private releaseOldestProviderStartMarker(): void {
    const record = [...this.providerToolCalls.values()].find((candidate) => candidate.startMarkerActive);
    if (record) this.releaseProviderStartMarker(record);
  }

  private releaseProviderStartMarker(record: ProviderToolCallRecord): void {
    if (!record.startMarkerActive) return;
    record.startMarkerActive = false;
    this.pendingStartToolCalls = Math.max(0, this.pendingStartToolCalls - 1);
    if (this.activeRunId || this.pendingStartToolCalls === 0) {
      this.flushDeferredProviderTerminal();
    }
  }

  private scheduleProviderToolOperation(operation: () => Promise<void>): void {
    this.providerToolOperations.push(operation);
    this.drainProviderToolOperations();
  }

  private drainProviderToolOperations(): void {
    while (
      !this.closing &&
      this.activeProviderToolOperations < MAX_CONCURRENT_PROVIDER_TOOL_CALLS &&
      this.providerToolOperations.length > 0
    ) {
      const operation = this.providerToolOperations.shift()!;
      this.activeProviderToolOperations += 1;
      void operation().catch((error) => {
        this.deps.logger.error("unexpected realtime tool operation failure", {
          sessionId: this.id,
          error: errorToMessage(error),
        });
      }).finally(() => {
        this.activeProviderToolOperations -= 1;
        this.drainProviderToolOperations();
      });
    }
  }

  private failProviderToolQueueOverflow(): void {
    if (this.closing) return;
    this.fail(
      "realtime_tool_queue_overflow",
      new Error("Realtime provider exceeded the safe pending tool-call limit."),
      false,
    );
    void this.closeClientAfterCleanup(1011, "realtime tool queue overflow");
  }

  private send(message: ServerMessage): void {
    this.client.sendText(serverMessage(message));
  }

  private handleClientMessageFailure(error: unknown, requestId?: string): void {
    if (this.closing) return;
    this.clientMessageErrors += 1;
    this.fail("client_message_failed", error, false, requestId);
    if (this.clientMessageErrors >= MAX_CLIENT_MESSAGE_ERRORS) {
      void this.closeClientAfterCleanup(1008, "too many invalid client messages");
    }
  }

  private fail(code: string, error: unknown, recoverable = false, requestId?: string): void {
    const message = errorToMessage(error);
    this.deps.logger.warn("live session error", { sessionId: this.id, code, message });
    this.send({ type: "session.error", code, message, recoverable, ...(requestId ? { requestId } : {}) });
  }
}

function validateAudioFrame(data: string, mimeType: string, maxBytes: number): void {
  if (typeof mimeType !== "string" || mimeType.length === 0 || mimeType.length > 128) {
    throw new Error("Audio frame MIME type is invalid.");
  }
  const decoded = decodeBase64Audio(data, maxBytes);
  if (decoded.length > maxBytes) {
    throw new Error("Audio frame exceeds HERMES_LIVE_MAX_AUDIO_BYTES.");
  }
  if (isPcmMimeType(mimeType)) {
    requirePcmSampleRate(mimeType);
    if (decoded.length % 2 !== 0) {
      throw new Error("PCM16 audio frames must contain an even number of bytes.");
    }
  }
}

function clientInboundFrameBytes(frame: ClientInboundFrame): number {
  return typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.byteLength;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedRunId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function clientCloseSeverity(code: number): number {
  if (code === 1000) return 0;
  if (code === 1008 || code === 1009) return 1;
  return 2;
}

function assertHermesRunEventCorrelation(event: HermesRunEvent, runId: string): void {
  if (event.run_id === undefined) return;
  if (!isBoundedRunId(event.run_id) || event.run_id !== runId) {
    throw new Error("Hermes emitted an event that did not match the active run stream.");
  }
}

function assertHermesResponseRunCorrelation(
  value: Record<string, unknown>,
  runId: string,
  label: string,
): void {
  if (value.run_id !== undefined && (!isBoundedRunId(value.run_id) || value.run_id !== runId)) {
    throw new Error(`Hermes ${label} response did not match the active run.`);
  }
  if (value.runId !== undefined && (!isBoundedRunId(value.runId) || value.runId !== runId)) {
    throw new Error(`Hermes ${label} response alias did not match the active run.`);
  }
}

function isPreemptiveClientControl(message: ClientMessage, sessionReady: boolean): boolean {
  if (message.type === "session.close") return true;
  return sessionReady && (
    message.type === "response.cancel" ||
    message.type === "run.stop" ||
    message.type === "approval.respond"
  );
}

function decodeBase64Audio(data: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) {
    throw new Error("Audio frame data must be base64 encoded.");
  }
  if (data.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new Error("Audio frame exceeds HERMES_LIVE_MAX_AUDIO_BYTES.");
  }
  return Buffer.from(data, "base64");
}

function validateText(value: string, maxChars: number, label: string): void {
  if (value.length > maxChars) {
    throw new Error(`${label} exceeds HERMES_LIVE_MAX_TEXT_CHARS.`);
  }
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

function requireProviderToolCallId(call: LiveToolCall): string {
  if (
    typeof call.name !== "string" ||
    call.name.length === 0 ||
    call.name.length > 128 ||
    !/^[A-Za-z0-9_.:-]+$/u.test(call.name)
  ) {
    throw new Error("Realtime provider emitted a tool call with an invalid name.");
  }
  if (
    typeof call.id !== "string" ||
    call.id.length === 0 ||
    call.id.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(call.id)
  ) {
    throw new Error("Realtime provider emitted a tool call without a bounded id.");
  }
  return call.id;
}

function providerToolCallFingerprint(call: LiveToolCall): string {
  let args: string;
  try {
    args = JSON.stringify(call.args);
  } catch {
    throw new Error("Realtime provider tool-call arguments were not serializable.");
  }
  if (Buffer.byteLength(args, "utf8") > MAX_PROVIDER_TOOL_CALL_ARGS_BYTES) {
    throw new Error("Realtime provider tool-call arguments exceeded the safe size limit.");
  }
  return createHash("sha256").update(call.name).update("\0").update(args).digest("hex");
}

function boundedProviderToolResponse(response: Record<string, unknown>): Record<string, unknown> {
  return safeJsonByteLength(response) <= MAX_PROVIDER_TOOL_RESPONSE_BYTES
    ? response
    : { ok: false, error: "Hermes tool result exceeded the safe provider response limit." };
}

function publicHermesRunStatus(value: Record<string, unknown>, runId: string): Record<string, unknown> {
  return { run_id: runId, status: publicRunStatus(value.status, "unknown") };
}

function publicRunStatus(value: unknown, fallback = "stopping"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return [
    "queued",
    "started",
    "in_progress",
    "running",
    "requires_action",
    "stopping",
    "cancelled",
    "canceled",
    "completed",
    "failed",
  ].includes(normalized)
    ? normalized
    : fallback;
}

function publicHermesCapabilities(
  capabilities: Awaited<ReturnType<HermesRunsPort["capabilities"]>>,
): { model?: string; capabilities?: Record<string, unknown> } {
  const model = boundedDisplayText(capabilities.model, 256);
  const source = capabilities.features;
  const projected: Record<string, unknown> = {};
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const key of ["run_submission", "run_events_sse", "run_stop", "run_approval_response"]) {
      if (typeof source[key] === "boolean") projected[key] = source[key];
    }
    projected[HERMES_TARGETED_APPROVAL_FEATURE] = source[HERMES_TARGETED_APPROVAL_FEATURE] === true;
  }
  return {
    ...(model ? { model } : {}),
    ...(Object.keys(projected).length > 0 ? { capabilities: projected } : {}),
  };
}

function publicRealtimeStartupError(error: unknown): string {
  const message = errorToMessage(error);
  if (
    message.startsWith("Realtime provider did not become ready within ") ||
    message === "Realtime provider session closed before ready." ||
    message === "Realtime provider exceeded the safe pre-ready event queue limit."
  ) {
    return boundedText(message, 500);
  }
  return "Realtime provider session failed to start. Check the gateway logs.";
}

function publicHermesRunEvent(
  event: HermesRunEvent,
  detail: AppConfig["server"]["runEventDetail"],
): HermesRunEvent | undefined {
  if (detail === "raw") {
    const serialized = safeJsonByteLength(event);
    if (serialized <= MAX_PUBLIC_RUN_EVENT_BYTES) return event;
    return {
      ...summarizeHermesRunEvent(event),
      truncated: true,
      original_bytes: serialized,
    };
  }
  if (detail === "none") {
    return undefined;
  }

  return summarizeHermesRunEvent(event);
}

function summarizeHermesRunEvent(event: HermesRunEvent): HermesRunEvent {
  const summary: Record<string, unknown> = {};
  for (const key of ["event", "run_id", "timestamp", "status", "approval_id"] as const) {
    const value = event[key];
    if (typeof value === "string") {
      summary[key] = boundedText(value, 512);
    } else if (typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
    }
  }
  return summary as HermesRunEvent;
}

function publicApprovalDetails(event: HermesRunEvent, approvalId: string): HermesApprovalDetails {
  const commandProjection = exactApprovalDisplayText(event.command, 4_000);
  const descriptionProjection = exactApprovalDisplayText(event.description, 2_000);
  const command = commandProjection.value;
  const description = descriptionProjection.value;
  const displayComplete = commandProjection.exact && descriptionProjection.exact && Boolean(command || description);
  const patterns = exactApprovalPatterns(event);
  const patternKey = displayComplete ? patterns.values[0] : undefined;
  const patternKeys = displayComplete && patterns.values.length > 1 ? patterns.values.slice(1) : undefined;
  const hasInspectablePermanentPattern = displayComplete && patterns.exact && patterns.values.length > 0;
  const fallbackChoices: Array<"once" | "session" | "always" | "deny"> = ["deny"];
  const allowedChoices = ["once", "session", "always", "deny"] as const;
  const suppliedChoices: Array<typeof allowedChoices[number]> = event.choices === undefined
    ? fallbackChoices
    : Array.isArray(event.choices) &&
        event.choices.length > 0 &&
        event.choices.every((choice) =>
          typeof choice === "string" && allowedChoices.includes(choice as typeof allowedChoices[number]),
        )
      ? event.choices as Array<typeof allowedChoices[number]>
      : ["deny"];
  const choices: Array<"once" | "session" | "always" | "deny"> = (
    suppliedChoices
  )
    .filter(
      (choice) =>
        (displayComplete || choice === "deny") &&
        ((choice !== "session" && choice !== "always") || hasInspectablePermanentPattern) &&
        (choice !== "always" || (hasInspectablePermanentPattern && event.allow_permanent === true)),
    )
    .filter((choice, index, all) => all.indexOf(choice) === index);
  if (!choices.includes("deny")) {
    choices.push("deny");
  }
  return {
    approvalId,
    ...(command ? { command } : {}),
    ...(description ? { description } : {}),
    ...(patternKey ? { patternKey } : {}),
    ...(patternKeys && patternKeys.length > 0 ? { patternKeys } : {}),
    choices,
    allowPermanent: hasInspectablePermanentPattern && event.allow_permanent === true && choices.includes("always"),
  };
}

function exactApprovalDisplayText(value: unknown, maximum: number): { value?: string; exact: boolean } {
  if (value === undefined || value === null || value === "") return { exact: true };
  if (typeof value !== "string" || /[\r\n\t]/u.test(value)) return { exact: false };
  const projected = boundedDisplayText(value, maximum);
  return projected && projected === value && /[\p{L}\p{N}\p{P}\p{S}]/u.test(projected)
    ? { value: projected, exact: true }
    : { exact: false };
}

function exactApprovalPatterns(event: HermesRunEvent): { values: string[]; exact: boolean } {
  const rawValues: unknown[] = [];
  if (event.pattern_key !== undefined && event.pattern_key !== null && event.pattern_key !== "") {
    rawValues.push(event.pattern_key);
  }
  if (event.pattern_keys !== undefined && event.pattern_keys !== null) {
    if (!Array.isArray(event.pattern_keys) || event.pattern_keys.length > 32) return { values: [], exact: false };
    rawValues.push(...event.pattern_keys);
  }
  if (rawValues.length > 32) return { values: [], exact: false };

  const values: string[] = [];
  for (const raw of rawValues) {
    const projected = boundedInspectablePattern(raw, 256);
    if (typeof raw !== "string" || !projected || projected !== raw) return { values: [], exact: false };
    if (!values.includes(projected)) values.push(projected);
  }
  return { values, exact: true };
}

function boundedDisplayText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const boundedInput = value.slice(0, maximum * 4 + 4_096);
  const withoutTerminalSequences = boundedInput
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n?/g, "\n");
  const printable = Array.from(withoutTerminalSequences.normalize("NFC"))
    .filter(
      (character) =>
        character === "\n" ||
        character === "\t" ||
        !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(character),
    )
    .slice(0, maximum)
    .join("")
    .trim();
  return printable || undefined;
}

function boundedInspectablePattern(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const boundedInput = value.slice(0, maximum * 4 + 4_096);
  const withoutTerminalSequences = boundedInput
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "");
  const printable = Array.from(withoutTerminalSequences.normalize("NFC"))
    .filter((character) => !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(character))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = Array.from(printable).slice(0, maximum).join("");
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(bounded) ? bounded : undefined;
}

function canApprovePermanently(approval: HermesApprovalDetails): boolean {
  return approval.allowPermanent && Boolean(approval.patternKey || approval.patternKeys?.length);
}

function approvalSourceKey(value: unknown): string | undefined {
  const sourceId = approvalSourceId(value);
  return sourceId ? createHash("sha256").update(sourceId).digest("hex") : undefined;
}

function approvalSourceId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function approvalResponseFingerprint(
  message: Extract<ClientMessage, { type: "approval.respond" }>,
): string {
  return createHash("sha256")
    .update(message.runId)
    .update("\0")
    .update(message.approvalId)
    .update("\0")
    .update(message.choice)
    .digest("hex");
}

function approvalSemanticFingerprint(approval: HermesApprovalDetails): string {
  return createHash("sha256")
    .update(JSON.stringify({
      command: approval.command ?? null,
      description: approval.description ?? null,
      patternKey: approval.patternKey ?? null,
      patternKeys: approval.patternKeys ?? [],
      choices: approval.choices,
      allowPermanent: approval.allowPermanent,
    }))
    .digest("hex");
}

function appendBoundedText(current: string, addition: string, maximum: number): string {
  if (current.length >= maximum || addition.length === 0) return current;
  return `${current}${addition.slice(0, maximum - current.length)}`;
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function boundedUsage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return safeJsonByteLength(value) <= MAX_PUBLIC_USAGE_BYTES
    ? value as Record<string, unknown>
    : { truncated: true };
}

function publicProviderCloseEvent(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const code = typeof record.code === "number" && Number.isSafeInteger(record.code)
    ? record.code
    : undefined;
  return code === undefined ? undefined : { code };
}

function providerCloseLogDetail(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const code = typeof record.code === "number" && Number.isSafeInteger(record.code) ? record.code : undefined;
  const reason = boundedDisplayText(record.reason, 2_000);
  return { ...(code === undefined ? {} : { providerCode: code }), ...(reason ? { providerReason: reason } : {}) };
}

function publicProviderIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\r\n\t]/u.test(value)) {
    return undefined;
  }
  const projected = boundedDisplayText(value, 256);
  return projected === value && /[\p{L}\p{N}\p{P}\p{S}]/u.test(value) ? value : undefined;
}

function publicContentIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function publicAudioStartMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60 * 60 * 1_000
    ? value
    : undefined;
}

function safeJsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function withAbortAndDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort?.(signal.reason ?? new DOMException("Aborted", "AbortError"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      promise,
      aborted,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
        timeout.unref?.();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (timeout) clearTimeout(timeout);
  }
}
