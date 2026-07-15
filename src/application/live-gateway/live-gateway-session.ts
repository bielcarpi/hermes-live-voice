import { createHash, randomUUID } from "node:crypto";
import { errorToMessage } from "../../domain/error-message.js";
import { isPcmMimeType, requirePcmSampleRate } from "../../domain/audio/pcm.js";
import { makeSessionKey, type AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import {
  parseClientMessage,
  RequestIdSchema,
  type ClientMessage,
  type RealtimeResponseTruncation,
} from "../../domain/protocol/client-protocol.js";
import {
  serverMessage,
  type PublicTaskSnapshot,
  type ServerMessage,
} from "../../domain/protocol/server-protocol.js";
import {
  HERMES_LIVE_PROTOCOL_VERSION,
  incompatibleProtocolVersionMessage,
  isHermesLiveProtocolVersion,
} from "../../domain/protocol/version.js";
import type { TaskExecutionMode, TaskRecord } from "../../domain/tasks/index.js";
import { realtimeClientCapabilities } from "./client-capabilities.js";
import type { ClientConnectionPort, ClientInboundFrame } from "./ports/client-connection.port.js";
import type { HermesRunsPort } from "./ports/hermes-runs.port.js";
import type { TaskSupervisorPort } from "./ports/task-supervisor.port.js";
import {
  type LiveModelEvent,
  type LiveToolCall,
  type LiveModelAdapter,
  type LiveModelSession,
} from "./ports/realtime-model.port.js";
import { buildSystemInstruction } from "./system-instruction.js";
import {
  projectSupersededTaskNotification,
  projectTaskLifecycle,
  projectTaskNotification,
  projectTaskSnapshot,
} from "./task-public-projection.js";

const MAX_PENDING_PROVIDER_EVENTS = 256;
const MAX_PENDING_PROVIDER_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_TRANSCRIPT_CHARS = 20_000;
const MAX_PROVIDER_IO_WAIT_MS = 10_000;
const MAX_PROVIDER_CLOSE_WAIT_MS = 5_000;
const MAX_PROVIDER_CANCEL_WAIT_MS = 1_000;
const MAX_PROVIDER_NOTIFICATION_RESPONSE_WAIT_MS = 30_000;
const MAX_PENDING_CLIENT_MESSAGES = 256;
const MAX_PENDING_CLIENT_BYTES = 8 * 1024 * 1024;
const MAX_CLIENT_MESSAGE_ERRORS = 16;
const MAX_PENDING_PROVIDER_TOOL_CALLS = 32;
const MAX_CONCURRENT_PROVIDER_TOOL_CALLS = 4;
const MAX_PROCESSED_PROVIDER_TOOL_CALLS = 256;
const MAX_SEEN_PROVIDER_TOOL_CALLS = 4_096;
const MAX_PROVIDER_TOOL_CALL_ARGS_BYTES = 100_000;
const MAX_PROVIDER_TOOL_RESPONSE_BYTES = 256_000;
const MAX_CACHED_PROVIDER_TOOL_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PUBLIC_TASKS = 100;
const MAX_TOOL_RESOURCE_KEYS = 8;

export interface LiveGatewaySessionDeps {
  config: AppConfig;
  hermes: HermesRunsPort;
  taskSupervisor: TaskSupervisorPort;
  liveModel: LiveModelAdapter;
  logger: Logger;
}

interface ProviderToolCallRecord {
  fingerprint: string;
  state: "pending" | "done";
  cancelled: boolean;
  responseDelivery: "not_started" | "sending" | "sent";
  response?: Record<string, unknown>;
  responseBytes?: number;
}

export class LiveGatewaySession {
  private readonly id = `live_${randomUUID().replaceAll("-", "")}`;
  private readonly notificationToken = randomUUID().replaceAll("-", "");
  private readonly abort = new AbortController();
  private liveSession?: LiveModelSession;
  private pendingLiveConnect?: Promise<LiveModelSession>;
  private starting = false;
  private readySent = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private sessionKey?: string;
  private ownerId?: string;
  private profileId = "default";
  private userLabel = "anonymous";
  private unsubscribeTasks?: () => void;
  private readonly pendingTaskRecords = new Map<string, TaskRecord>();
  private readonly pendingNotifications = new Map<string, TaskRecord>();
  private notificationFlushRunning = false;
  private notificationResponsePending = false;
  private notificationResponseTimer?: ReturnType<typeof setTimeout>;
  private providerResponseActive = false;
  private userSpeaking = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private pendingClientMessages = 0;
  private pendingClientBytes = 0;
  private clientInputOverflowed = false;
  private clientMessageErrors = 0;
  private readonly providerToolCalls = new Map<string, ProviderToolCallRecord>();
  private readonly providerToolCallTombstones = new Map<string, string>();
  private readonly providerToolOperations: Array<() => Promise<void>> = [];
  private activeProviderToolOperations = 0;
  private pendingProviderToolCalls = 0;
  private cachedProviderToolResponseBytes = 0;

  constructor(
    private readonly client: ClientConnectionPort,
    private readonly deps: LiveGatewaySessionDeps,
  ) {}

  bind(): void {
    this.client.onMessage((frame) => this.enqueueClientFrame(frame));
    this.client.onClose(() => {
      void this.close();
    });
    this.client.onError((error) => {
      this.deps.logger.warn("client connection error", { sessionId: this.id, error: errorToMessage(error) });
    });
  }

  async start(message: Extract<ClientMessage, { type: "session.start" }>): Promise<void> {
    if (!isHermesLiveProtocolVersion(message.protocolVersion)) {
      this.fail(
        "unsupported_protocol_version",
        new Error(incompatibleProtocolVersionMessage(message.protocolVersion)),
        false,
        message.id,
      );
      return;
    }
    if (this.liveSession || this.starting || this.readySent) {
      this.fail("session_already_started", new Error("Realtime session is already started."), true, message.id);
      return;
    }

    this.starting = true;
    let startupPhase: "hermes" | "realtime" = "hermes";
    let connected: LiveModelSession | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      this.profileId = this.deps.config.server.trustClientIdentity
        ? message.profileId ?? this.deps.config.server.defaultProfileId
        : this.deps.config.server.defaultProfileId;
      this.userLabel = this.deps.config.server.trustClientIdentity
        ? message.userLabel ?? this.deps.config.server.defaultUserLabel
        : this.deps.config.server.defaultUserLabel;
      this.sessionKey = makeSessionKey(this.deps.config.server.sessionPrefix, this.profileId, this.userLabel);
      this.ownerId = this.deps.taskSupervisor.registerOwner(this.sessionKey, this.sessionKey);
      unsubscribe = this.deps.taskSupervisor.subscribe(this.ownerId, (record) => this.receiveTaskRecord(record));
      this.unsubscribeTasks = unsubscribe;

      const capabilities = await this.deps.hermes.assertRunsSupported(this.abort.signal);
      startupPhase = "realtime";
      const providerEvents: LiveModelEvent[] = [];
      let providerEventBytes = 0;
      let providerOpened = false;
      let resolveOpen!: () => void;
      let rejectOpen!: (error: Error) => void;
      const providerOpen = new Promise<void>((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      });

      const connect = this.deps.liveModel.connect({
        sessionId: this.id,
        systemInstruction: buildSystemInstruction(this.notificationToken),
        safetyIdentifier: safetyIdentifierForSessionKey(this.sessionKey),
        callbacks: {
          onOpen: () => {
            providerOpened = true;
            resolveOpen();
          },
          onClose: (event) => {
            if (!this.readySent) {
              rejectOpen(new Error("Realtime provider session closed before ready."));
              return;
            }
            this.deps.logger.info("realtime provider session closed", {
              sessionId: this.id,
              ...providerCloseLogDetail(event),
            });
            if (this.closing) return;
            this.fail("realtime_provider_closed", new Error("Realtime provider session closed."), true);
            void this.closeClientAfterCleanup(1011, "realtime provider closed");
          },
          onError: (error) => {
            if (!this.readySent) {
              rejectOpen(new Error(publicRealtimeStartupError(error, this.deps.config.server.providerReadyTimeoutMs)));
              return;
            }
            this.deps.logger.warn("realtime provider reported an error", {
              sessionId: this.id,
              error: "realtime_provider_error",
            });
            if (!this.closing) {
              this.fail("realtime_provider_error", new Error("Realtime provider reported an error."), true);
            }
          },
          onEvent: (event) => {
            if (this.closing) return;
            if (!this.readySent) {
              const bytes = safeJsonByteLength(event);
              if (
                providerEvents.length >= MAX_PENDING_PROVIDER_EVENTS ||
                !Number.isFinite(bytes) ||
                bytes > MAX_PENDING_PROVIDER_EVENT_BYTES - providerEventBytes
              ) {
                rejectOpen(new Error("Realtime provider exceeded the safe pre-ready event queue limit."));
                return;
              }
              providerEvents.push(event);
              providerEventBytes += bytes;
              return;
            }
            this.dispatchLiveModelEvent(event);
          },
        },
      });
      this.pendingLiveConnect = connect;
      void connect.catch(() => undefined);
      connected = await withDeadline(
        connect,
        this.deps.config.server.providerReadyTimeoutMs,
        `Realtime provider did not connect within ${this.deps.config.server.providerReadyTimeoutMs}ms.`,
      );
      if (this.pendingLiveConnect === connect) this.pendingLiveConnect = undefined;
      this.liveSession = connected;
      if (!providerOpened) {
        await withDeadline(
          providerOpen,
          this.deps.config.server.providerReadyTimeoutMs,
          `Realtime provider did not become ready within ${this.deps.config.server.providerReadyTimeoutMs}ms.`,
        );
      }
      if (this.closing) {
        await this.closeProvider(connected);
        return;
      }

      // Recent history is intentionally bounded for the public inbox, but
      // active work and unread notifications are correctness-critical. Load
      // those independently so neither can disappear behind newer terminal
      // history, then de-duplicate and project the union in bounded frames.
      const [recentWindow, activeTasks, unreadTasks] = await Promise.all([
        this.deps.taskSupervisor.list(this.ownerId, MAX_PUBLIC_TASKS + 1),
        this.deps.taskSupervisor.listActive(this.ownerId),
        this.deps.taskSupervisor.listUnreadNotifications(this.ownerId),
      ]);
      const initialTasks = mergeTaskRecords([
        ...activeTasks,
        ...unreadTasks,
        ...recentWindow.slice(0, MAX_PUBLIC_TASKS),
      ]);
      const projectedInitialTasks = projectTaskList(initialTasks);
      const initialSnapshotTruncated = recentWindow.length > MAX_PUBLIC_TASKS
        || projectedInitialTasks.length > MAX_PUBLIC_TASKS;
      this.send({
        type: "session.ready",
        protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
        ...(message.id ? { requestId: message.id } : {}),
        sessionId: this.id,
        model: this.deps.config.realtime.model,
        hermes: publicHermesCapabilities(capabilities),
        realtime: realtimeClientCapabilities(this.deps.config),
        tasks: {
          scope: "owner",
          sequence: "per_task",
          reconnect: "snapshot",
          durable: true,
          parallel: this.deps.config.tasks.maxConcurrent > 1,
          maxConcurrent: this.deps.config.tasks.maxConcurrent,
          maxRetained: this.deps.config.tasks.historyLimit,
          supports: { list: true, get: true, stop: true, resume: false, notificationAck: true },
        },
      });
      const initialSnapshotReason = initialTasks.length > 0 ? "reconnect" : "initial";
      if (projectedInitialTasks.length === 0) {
        this.send({
          type: "task.snapshot",
          reason: initialSnapshotReason,
          tasks: [],
          truncated: false,
        });
      } else {
        for (let offset = 0; offset < projectedInitialTasks.length; offset += MAX_PUBLIC_TASKS) {
          this.send({
            type: "task.snapshot",
            reason: initialSnapshotReason,
            tasks: projectedInitialTasks.slice(offset, offset + MAX_PUBLIC_TASKS),
            // `truncated` describes the bounded recent-history view, not a
            // pagination cursor. Active and unread records are still emitted
            // across every bounded reconnect frame.
            truncated: initialSnapshotTruncated,
          });
        }
      }
      this.readySent = true;
      const initialTaskSequences = new Map(initialTasks.map((record) => [record.taskId, record.sequence]));
      for (const record of unreadTasks) {
        const notification = projectTaskNotification(record);
        if (!record.notification.unread || !notification) continue;
        this.send({
          type: "task.notification",
          taskId: record.taskId,
          sequence: record.sequence,
          occurredAt: record.updatedAt,
          notification,
        });
        // Client inbox delivery and provider speech have independent durable
        // state. Re-project every unread item on reconnect, but never enqueue
        // one that has already been announced for speech again.
        if (record.notification.announcedAt === undefined) {
          this.pendingNotifications.set(record.taskId, structuredClone(record));
        }
      }
      for (const record of this.pendingTaskRecords.values()) {
        if (record.sequence > (initialTaskSequences.get(record.taskId) ?? 0)) this.dispatchTaskRecord(record);
      }
      this.pendingTaskRecords.clear();
      for (const event of providerEvents) this.dispatchLiveModelEvent(event);
      this.scheduleNotificationFlush();
    } catch (error) {
      if (this.pendingLiveConnect) {
        const lateConnect = this.pendingLiveConnect;
        this.pendingLiveConnect = undefined;
        void lateConnect.then((session) => this.closeProvider(session)).catch(() => undefined);
      }
      if (connected) await this.closeProvider(connected).catch(() => undefined);
      if (this.liveSession === connected) this.liveSession = undefined;
      if (unsubscribe && this.unsubscribeTasks === unsubscribe) {
        unsubscribe();
        this.unsubscribeTasks = undefined;
      }
      if (!this.closing) {
        this.deps.logger.warn("live session startup failed", {
          sessionId: this.id,
          phase: startupPhase,
          error: "startup_failed",
        });
        this.fail(
          "session_start_failed",
          new Error(
            startupPhase === "hermes"
              ? "Hermes Agent is not ready for background tasks. Check the authenticated /ready endpoint and gateway logs."
              : publicRealtimeStartupError(error, this.deps.config.server.providerReadyTimeoutMs),
          ),
          true,
          message.id,
        );
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

  private enqueueClientFrame(frame: ClientInboundFrame): void {
    if (this.closing || this.clientInputOverflowed) return;
    const bytes = clientInboundFrameBytes(frame);
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
      const text = typeof frame === "string" ? frame : new TextDecoder().decode(frame);
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
        if (!this.closing && !this.clientInputOverflowed) {
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
      this.messageQueue = this.messageQueue.then(processMessage, processMessage);
    }
  }

  private async handleClientMessage(message: ClientMessage): Promise<void> {
    if (message.type === "session.start") {
      await this.start(message);
      return;
    }
    if (message.type === "session.close") {
      await this.closeClientAfterCleanup(1000, "session detached");
      return;
    }
    if (!this.liveSession || !this.ownerId || !this.sessionKey || !this.readySent) {
      this.fail("session_not_started", new Error("Send session.start before using the live session."), true, message.id);
      return;
    }

    switch (message.type) {
      case "audio.input":
        validateAudioFrame(message.data, message.mimeType, this.deps.config.server.maxAudioBytes);
        this.userSpeaking = true;
        await this.forwardRealtimeClientInput(
          "audio",
          () => this.liveSession!.sendRealtimeAudio({ data: message.data, mimeType: message.mimeType }),
        );
        return;
      case "audio.end":
        this.userSpeaking = false;
        await this.forwardRealtimeClientInput("audio turn", () => this.liveSession!.sendAudioStreamEnd(), true);
        return;
      case "text.input":
        validateText(message.text, this.deps.config.server.maxTextChars, "Text input");
        this.userSpeaking = false;
        await this.forwardRealtimeClientInput("text", () => this.liveSession!.sendText(message.text), true);
        return;
      case "response.cancel":
        await this.cancelRealtimeResponse(message.reason, message.truncate);
        return;
      case "task.list": {
        const taskWindow = await this.runTaskOperation(
          () => this.deps.taskSupervisor.list(this.ownerId!, message.limit + 1),
          "Unable to read the background task inbox.",
        );
        const tasks = taskWindow.slice(0, message.limit);
        this.send({
          type: "task.snapshot",
          reason: "list",
          requestId: message.id,
          tasks: projectTaskList(tasks),
          truncated: taskWindow.length > message.limit,
        });
        return;
      }
      case "task.get": {
        const task = await this.runTaskOperation(
          () => this.deps.taskSupervisor.get(this.ownerId!, message.taskId),
          "Unable to read that background task.",
        );
        this.send({
          type: "task.snapshot",
          reason: "get",
          requestId: message.id,
          tasks: task ? [projectTaskSnapshot(task, { includeOutput: true })] : [],
          truncated: false,
        });
        return;
      }
      case "task.stop": {
        const task = await this.runTaskOperation(
          () => this.deps.taskSupervisor.stop(this.ownerId!, message.taskId, message.reason),
          "Unable to stop that background task safely.",
        );
        this.send(projectTaskLifecycle(task, message.id));
        return;
      }
      case "task.notification.ack": {
        const current = await this.runTaskOperation(
          () => this.deps.taskSupervisor.get(this.ownerId!, message.taskId),
          "Unable to acknowledge that task notification.",
        );
        const currentNotification = current ? projectTaskNotification(current) : undefined;
        if (
          !current ||
          !current.notification.unread ||
          !currentNotification ||
          currentNotification.notificationId !== message.notificationId
        ) {
          throw new Error("Notification acknowledgement does not match the current task notification.");
        }
        const task = await this.runTaskOperation(
          () => this.deps.taskSupervisor.acknowledgeNotification(this.ownerId!, message.taskId),
          "Unable to acknowledge that task notification.",
        );
        const notification = projectTaskNotification(task);
        if (notification) {
          this.send({
            type: "task.notification",
            taskId: task.taskId,
            sequence: task.sequence,
            occurredAt: task.updatedAt,
            requestId: message.id,
            notification,
          });
        }
        return;
      }
    }
  }

  private executeToolCall(call: LiveToolCall): Promise<Record<string, unknown>> {
    if (!this.ownerId || !this.sessionKey) throw new Error("session.start has not completed.");
    switch (call.name) {
      case "start_background_task": {
        const message = stringArg(call, "message");
        if (!message) throw new Error("start_background_task requires message.");
        validateText(message, this.deps.config.server.maxTextChars, "Background task message");
        const recentContext = optionalStringArg(call, "recent_voice_context");
        if (recentContext) validateText(recentContext, this.deps.config.server.maxTextChars, "Recent voice context");
        const title = optionalStringArg(call, "title");
        if (title && title.length > 256) throw new Error("Background task title exceeds 256 characters.");
        const executionMode = executionModeArg(call);
        const resourceKeys = resourceKeysArg(call);
        const input = recentContext ? `${message}\n\nRecent voice context:\n${recentContext}` : message;
        return this.runTaskOperation(() => this.deps.taskSupervisor.submit({
          ownerIdentity: this.sessionKey!,
          sessionKey: this.sessionKey!,
          input,
          ...(title ? { title } : {}),
          executionMode,
          ...(resourceKeys ? { resourceKeys } : {}),
        }), "Background task could not be accepted safely.").then((task) => ({
          ok: true,
          task_id: task.taskId,
          status: task.status,
          message: "Background task accepted. The user can keep talking or disconnect.",
        }));
      }
      case "list_background_tasks": {
        const includeCompleted = booleanArg(call, "include_completed", true);
        return this.runTaskOperation(
          () => this.deps.taskSupervisor.list(this.ownerId!, 25),
          "Unable to read the background task inbox.",
        ).then((records) => ({
          ok: true,
          tasks: records
            .filter((record) => includeCompleted || !["completed", "failed", "cancelled"].includes(record.status))
            .map((record) => projectTaskSnapshot(record)),
        }));
      }
      case "get_background_task": {
        const taskId = stringArg(call, "task_id");
        if (!taskId) throw new Error("get_background_task requires task_id.");
        const includeOutput = booleanArg(call, "include_output", false);
        return this.runTaskOperation(
          () => this.deps.taskSupervisor.get(this.ownerId!, taskId),
          "Unable to read that background task.",
        ).then((task) => task
          ? { ok: true, task: projectTaskSnapshot(task, { includeOutput }) }
          : { ok: false, task_id: taskId, error: "Task not found." });
      }
      case "stop_background_task": {
        const taskId = stringArg(call, "task_id");
        if (!taskId) throw new Error("stop_background_task requires task_id.");
        return this.runTaskOperation(
          () => this.deps.taskSupervisor.stop(this.ownerId!, taskId, optionalStringArg(call, "reason")),
          "Unable to stop that background task safely.",
        ).then((task) => ({
          ok: true,
          task_id: task.taskId,
          status: task.status,
        }));
      }
      default:
        return Promise.resolve({ ok: false, error: `Unknown hermes-live tool: ${call.name}` });
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
        this.fail("realtime_tool_call_conflict", new Error("Realtime provider reused a tool-call id."), false);
        void this.closeClientAfterCleanup(1011, "conflicting realtime tool call");
        return;
      }
      if (existing.cancelled || existing.state !== "done") return;
      if (!existing.response) {
        this.failExpiredProviderToolCallReplay();
        return;
      }
      this.scheduleProviderToolOperation(() => this.deliverProviderToolResponse(call, existing.response!, existing));
      return;
    }

    const tombstoneFingerprint = this.providerToolCallTombstones.get(providerToolCallIdDigest(id));
    if (tombstoneFingerprint) {
      if (tombstoneFingerprint !== fingerprint) {
        this.fail("realtime_tool_call_conflict", new Error("Realtime provider reused a tool-call id."), false);
        void this.closeClientAfterCleanup(1011, "conflicting realtime tool call");
        return;
      }
      this.failExpiredProviderToolCallReplay();
      return;
    }

    if (this.pendingProviderToolCalls >= MAX_PENDING_PROVIDER_TOOL_CALLS) {
      this.failProviderToolQueueOverflow();
      return;
    }
    if (this.providerToolCalls.size + this.providerToolCallTombstones.size >= MAX_SEEN_PROVIDER_TOOL_CALLS) {
      this.failProviderToolReplayLedgerOverflow();
      return;
    }
    if (this.providerToolCalls.size >= MAX_PROCESSED_PROVIDER_TOOL_CALLS) {
      const oldestDone = [...this.providerToolCalls].find(([, record]) => record.state === "done");
      if (!oldestDone) {
        this.failProviderToolQueueOverflow();
        return;
      }
      this.cachedProviderToolResponseBytes = Math.max(
        0,
        this.cachedProviderToolResponseBytes - (oldestDone[1].responseBytes ?? 0),
      );
      this.providerToolCalls.delete(oldestDone[0]);
      this.providerToolCallTombstones.set(providerToolCallIdDigest(oldestDone[0]), oldestDone[1].fingerprint);
    }

    const record: ProviderToolCallRecord = {
      fingerprint,
      state: "pending",
      cancelled: false,
      responseDelivery: "not_started",
    };
    this.providerToolCalls.set(id, record);
    this.pendingProviderToolCalls += 1;
    this.scheduleProviderToolOperation(async () => {
      try {
        if (record.cancelled) return;
        let response: Record<string, unknown>;
        try {
          response = await this.executeToolCall(call);
        } catch (error) {
          const publicMessage = error instanceof PublicTaskOperationError
            ? error.message
            : "Background task request was rejected.";
          const operationError = error instanceof PublicTaskOperationError ? error.operationCause : error;
          response = { ok: false, error: publicMessage };
          if (!record.cancelled) {
            this.failPublic("tool_call_failed", publicMessage, operationError, true);
          }
        }
        response = boundedProviderToolResponse(response);
        record.state = "done";
        if (!record.cancelled) {
          const bytes = safeJsonByteLength(response);
          if (bytes <= MAX_CACHED_PROVIDER_TOOL_RESPONSE_BYTES - this.cachedProviderToolResponseBytes) {
            record.response = response;
            record.responseBytes = bytes;
            this.cachedProviderToolResponseBytes += bytes;
          }
          await this.deliverProviderToolResponse(call, response, record);
        }
      } finally {
        record.state = "done";
        this.pendingProviderToolCalls -= 1;
      }
    });
  }

  private handleProviderToolCallCancellation(callIds: string[]): void {
    if (callIds.length === 0 || callIds.length > MAX_PROCESSED_PROVIDER_TOOL_CALLS) {
      throw new Error("Realtime provider emitted an invalid tool-call cancellation batch.");
    }
    for (const id of new Set(callIds.map(requireProviderToolCancellationId))) {
      const record = this.providerToolCalls.get(id);
      if (!record) {
        if (this.providerToolCallTombstones.has(providerToolCallIdDigest(id))) {
          this.send({ type: "log", level: "info", message: "Realtime provider cancelled a completed tool call" });
          continue;
        }
        this.fail("realtime_tool_cancellation_unknown", new Error("Realtime provider cancelled an unknown tool call."), false);
        void this.closeClientAfterCleanup(1011, "uncorrelated realtime tool cancellation");
        return;
      }
      if (record.responseDelivery === "sending") {
        this.fail(
          "realtime_tool_cancellation_delivery_indeterminate",
          new Error("The realtime provider cancelled a tool result while it was being delivered."),
          false,
        );
        void this.closeClientAfterCleanup(1011, "realtime tool delivery indeterminate");
        return;
      }
      record.cancelled = true;
      if (record.responseBytes) {
        this.cachedProviderToolResponseBytes = Math.max(0, this.cachedProviderToolResponseBytes - record.responseBytes);
      }
      record.response = undefined;
      record.responseBytes = undefined;
      this.send({ type: "log", level: "info", message: "Realtime provider cancelled a tool call" });
    }
  }

  private async deliverProviderToolResponse(
    call: LiveToolCall,
    response: Record<string, unknown>,
    record: ProviderToolCallRecord,
  ): Promise<void> {
    if (record.cancelled || this.closing || !this.liveSession) return;
    record.responseDelivery = "sending";
    try {
      await withAbortAndDeadline(
        this.liveSession.sendToolResponse(call, response),
        this.abort.signal,
        MAX_PROVIDER_IO_WAIT_MS,
        "Realtime provider tool response did not settle before the safety deadline.",
      );
      if (!record.cancelled) record.responseDelivery = "sent";
    } catch (error) {
      if (this.closing) return;
      this.deps.logger.warn("failed to send realtime tool response", {
        sessionId: this.id,
        error: "realtime_provider_tool_response_failed",
      });
      this.fail("realtime_tool_response_failed", new Error("Realtime provider could not accept the task receipt."), false);
      await this.closeClientAfterCleanup(1011, "realtime tool response failed");
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
    this.fail("realtime_tool_queue_overflow", new Error("Realtime provider exceeded the safe tool-call limit."), false);
    void this.closeClientAfterCleanup(1011, "realtime tool queue overflow");
  }

  private failExpiredProviderToolCallReplay(): void {
    this.fail(
      "realtime_tool_call_replay_expired",
      new Error("Realtime provider replayed a completed tool call after its response cache expired."),
      false,
    );
    void this.closeClientAfterCleanup(1011, "realtime tool replay expired");
  }

  private failProviderToolReplayLedgerOverflow(): void {
    this.fail(
      "realtime_tool_replay_ledger_overflow",
      new Error("Realtime provider exceeded the safe lifetime tool-call limit."),
      false,
    );
    void this.closeClientAfterCleanup(1011, "realtime tool replay ledger overflow");
  }

  private dispatchLiveModelEvent(event: LiveModelEvent): void {
    if (this.closing) return;
    try {
      this.handleLiveModelEvent(event);
    } catch (error) {
      this.deps.logger.warn("invalid realtime provider event", { sessionId: this.id, error: errorToMessage(error) });
      this.fail("realtime_provider_event_invalid", new Error("Realtime provider emitted an invalid event."), false);
      void this.closeClientAfterCleanup(1011, "invalid realtime provider event");
    }
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
      return;
    }
    if (event.type === "text") {
      if (!event.text || event.text.length > MAX_PROVIDER_TRANSCRIPT_CHARS) {
        throw new Error("Realtime provider transcript is empty or exceeds its limit.");
      }
      if ((event.speaker ?? "assistant") === "user" && event.final) {
        this.userSpeaking = false;
      }
      this.send({
        type: "transcript.delta",
        speaker: event.speaker ?? "assistant",
        text: event.text,
        ...(event.final === undefined ? {} : { final: event.final }),
      });
      return;
    }
    if (event.type === "tool_call") {
      this.enqueueProviderToolCall(event.call);
      return;
    }
    if (event.type === "tool_call_cancelled") {
      this.handleProviderToolCallCancellation(event.callIds);
      return;
    }
    if (event.type === "input_speech_started") {
      this.userSpeaking = true;
      const itemId = publicProviderIdentifier(event.itemId);
      const audioStartMs = publicAudioStartMs(event.audioStartMs);
      this.send({
        type: "input.speech_started",
        provider: event.provider,
        ...(itemId ? { itemId } : {}),
        ...(audioStartMs === undefined ? {} : { audioStartMs }),
      });
      return;
    }
    if (event.status === "started") {
      this.providerResponseActive = true;
      const responseId = publicProviderIdentifier(event.responseId);
      this.send({ type: "response.started", ...(responseId ? { responseId } : {}) });
      return;
    }

    this.providerResponseActive = false;
    this.clearNotificationResponsePending();
    const responseId = publicProviderIdentifier(event.responseId);
    if (event.status === "failed") {
      this.send({
        type: "response.failed",
        ...(responseId ? { responseId } : {}),
        error: "Realtime provider response failed. Check the gateway logs.",
      });
    } else if (event.status === "completed") {
      this.send({ type: "response.completed", ...(responseId ? { responseId } : {}) });
    } else {
      this.send({ type: "response.cancelled", ...(responseId ? { responseId } : {}) });
    }
    this.scheduleNotificationFlush();
  }

  private receiveTaskRecord(record: TaskRecord): void {
    if (this.closing) return;
    if (!this.readySent) {
      this.pendingTaskRecords.set(record.taskId, structuredClone(record));
      return;
    }
    this.dispatchTaskRecord(record);
  }

  private dispatchTaskRecord(record: TaskRecord): void {
    const latestType = record.events.at(-1)?.type;
    const notificationMetadataOnly = latestType === "notification.announced"
      || latestType === "notification.acknowledged";
    if (!notificationMetadataOnly) {
      this.send(projectTaskLifecycle(record));
    }
    const notification = projectTaskNotification(record)
      ?? projectSupersededTaskNotification(record);
    // Announcement ownership is internal metadata. Acknowledgements, however,
    // must be broadcast so every connected client clears the same durable
    // unread item rather than only the client that sent the request.
    if (notification && latestType !== "notification.announced") {
      this.send({
        type: "task.notification",
        taskId: record.taskId,
        sequence: record.sequence,
        occurredAt: record.updatedAt,
        notification,
      });
    }
    if (record.notification.unread && record.notification.announcedAt === undefined && notification) {
      this.pendingNotifications.set(record.taskId, structuredClone(record));
    } else {
      this.pendingNotifications.delete(record.taskId);
    }
    this.scheduleNotificationFlush();
  }

  private scheduleNotificationFlush(): void {
    if (
      this.closing ||
      !this.readySent ||
      this.notificationFlushRunning ||
      this.notificationResponsePending ||
      this.providerResponseActive ||
      this.userSpeaking ||
      this.pendingNotifications.size === 0
    ) {
      return;
    }
    queueMicrotask(() => {
      void this.flushNotifications();
    });
  }

  private async flushNotifications(): Promise<void> {
    if (
      this.closing ||
      this.notificationFlushRunning ||
      this.notificationResponsePending ||
      this.providerResponseActive ||
      this.userSpeaking ||
      !this.liveSession?.sendTaskNotification ||
      !this.ownerId
    ) {
      return;
    }
    const candidates = [...this.pendingNotifications.values()];
    if (candidates.length === 0) return;
    this.notificationFlushRunning = true;
    try {
      const records: TaskRecord[] = [];
      for (const candidate of candidates) {
        try {
          const claim = await this.deps.taskSupervisor.claimNotificationAnnouncement(
            this.ownerId,
            candidate.taskId,
          );
          this.pendingNotifications.delete(candidate.taskId);
          if (claim.claimed) records.push(claim.task);
        } catch (error) {
          this.deps.logger.warn("failed to claim task notification announcement", {
            sessionId: this.id,
            taskId: candidate.taskId,
            error: errorToMessage(error),
          });
        }
      }
      if (records.length === 0) return;

      this.notificationResponsePending = true;
      const announcement = notificationDigest(records);
      const context = `[HERMES_LIVE_TASK_EVENT_V1:${this.notificationToken}] ${JSON.stringify({ announcement })}`;
      await withAbortAndDeadline(
        this.liveSession.sendTaskNotification({ context, announcement }),
        this.abort.signal,
        MAX_PROVIDER_IO_WAIT_MS,
        "Realtime provider task notification did not settle before the safety deadline.",
      );
      this.armNotificationResponseWatchdog();
    } catch (error) {
      this.notificationResponsePending = false;
      if (!this.closing) {
        this.deps.logger.warn("task notification speech delivery failed", {
          sessionId: this.id,
          error: errorToMessage(error),
        });
      }
    } finally {
      this.notificationFlushRunning = false;
    }
  }

  private async forwardRealtimeClientInput(
    label: string,
    operation: () => Promise<void>,
    beginsResponse = false,
  ): Promise<void> {
    if (beginsResponse) this.providerResponseActive = true;
    try {
      await withAbortAndDeadline(
        operation(),
        this.abort.signal,
        MAX_PROVIDER_IO_WAIT_MS,
        `Realtime provider ${label} input did not settle before the safety deadline.`,
      );
    } catch (error) {
      if (beginsResponse) this.providerResponseActive = false;
      if (this.closing) return;
      this.deps.logger.warn("realtime provider rejected client input", {
        sessionId: this.id,
        input: label,
        error: errorToMessage(error),
      });
      this.fail("realtime_provider_input_failed", new Error(`Realtime provider could not confirm ${label} input.`), false);
      await this.closeClientAfterCleanup(1011, "realtime provider input failed");
    }
  }

  private async cancelRealtimeResponse(reason?: string, truncate?: RealtimeResponseTruncation): Promise<void> {
    try {
      const cancelled = await withDeadline(
        Promise.resolve(this.liveSession?.cancelResponse(reason, truncate) ?? false),
        MAX_PROVIDER_CANCEL_WAIT_MS,
        "Realtime response cancellation did not settle before the safety deadline.",
      );
      if (!this.closing) {
        this.send({
          type: "log",
          level: cancelled ? "info" : "debug",
          message: cancelled ? "Realtime response cancellation requested" : "No active realtime response to cancel",
        });
      }
    } catch (error) {
      if (!this.closing) {
        this.deps.logger.warn("failed to cancel realtime response", {
          sessionId: this.id,
          error: errorToMessage(error),
        });
        this.send({ type: "log", level: "warn", message: "Realtime response cancellation failed" });
      }
    }
  }

  private async performClose(): Promise<void> {
    this.unsubscribeTasks?.();
    this.unsubscribeTasks = undefined;
    this.pendingTaskRecords.clear();
    this.pendingNotifications.clear();
    this.clearNotificationResponsePending();
    this.providerToolOperations.length = 0;
    this.abort.abort(new Error("Voice session detached."));

    const operations: Promise<unknown>[] = [];
    if (this.liveSession) operations.push(this.closeProvider(this.liveSession));
    if (this.pendingLiveConnect) {
      const connect = this.pendingLiveConnect;
      this.pendingLiveConnect = undefined;
      operations.push(connect.then((session) => this.closeProvider(session)).catch(() => undefined));
    }
    await Promise.allSettled(operations);
  }

  private async closeProvider(session: LiveModelSession): Promise<void> {
    await withDeadline(
      Promise.resolve().then(() => session.close()),
      MAX_PROVIDER_CLOSE_WAIT_MS,
      "Realtime provider did not confirm closure before the safety deadline.",
    ).catch((error) => {
      this.deps.logger.error("failed to confirm realtime provider closure", {
        sessionId: this.id,
        error: errorToMessage(error),
      });
    });
  }

  private async closeClientAfterCleanup(code: number, reason: string): Promise<void> {
    await this.close();
    this.client.close(code, reason);
  }

  private send(message: ServerMessage): void {
    if (this.closing && message.type !== "session.error") return;
    this.client.sendText(serverMessage(message));
  }

  private handleClientMessageFailure(error: unknown, requestId?: string): void {
    if (this.closing) return;
    this.clientMessageErrors += 1;
    if (error instanceof PublicTaskOperationError) {
      this.failPublic("client_message_failed", error.message, error.operationCause, false, requestId);
    } else {
      this.fail("client_message_failed", error, false, requestId);
    }
    if (this.clientMessageErrors >= MAX_CLIENT_MESSAGE_ERRORS) {
      void this.closeClientAfterCleanup(1008, "too many invalid client messages");
    }
  }

  private fail(code: string, error: unknown, recoverable = false, requestId?: string): void {
    const message = boundedText(errorToMessage(error), 2_000);
    const safeRequestId = validatedRequestId(requestId);
    this.deps.logger.warn("live session error", { sessionId: this.id, code, message });
    this.send({
      type: "session.error",
      code,
      message,
      recoverable,
      ...(safeRequestId ? { requestId: safeRequestId } : {}),
    });
  }

  private failPublic(
    code: string,
    publicMessage: string,
    operationError: unknown,
    recoverable = false,
    requestId?: string,
  ): void {
    const message = boundedText(publicMessage, 500);
    const safeRequestId = validatedRequestId(requestId);
    this.deps.logger.warn("live session operation failed", {
      sessionId: this.id,
      code,
      error: errorToMessage(operationError),
    });
    this.send({
      type: "session.error",
      code,
      message,
      recoverable,
      ...(safeRequestId ? { requestId: safeRequestId } : {}),
    });
  }

  private runTaskOperation<T>(operation: () => Promise<T>, fallbackMessage: string): Promise<T> {
    return Promise.resolve().then(operation).catch((error) => {
      throw new PublicTaskOperationError(publicTaskOperationMessage(error, fallbackMessage), error);
    });
  }

  private armNotificationResponseWatchdog(): void {
    if (this.notificationResponseTimer) clearTimeout(this.notificationResponseTimer);
    this.notificationResponseTimer = setTimeout(() => {
      this.notificationResponseTimer = undefined;
      this.notificationResponsePending = false;
      this.scheduleNotificationFlush();
    }, MAX_PROVIDER_NOTIFICATION_RESPONSE_WAIT_MS);
    this.notificationResponseTimer.unref?.();
  }

  private clearNotificationResponsePending(): void {
    this.notificationResponsePending = false;
    if (this.notificationResponseTimer) {
      clearTimeout(this.notificationResponseTimer);
      this.notificationResponseTimer = undefined;
    }
  }
}

class PublicTaskOperationError extends Error {
  readonly operationCause: unknown;

  constructor(publicMessage: string, operationCause: unknown) {
    super(publicMessage);
    this.name = "PublicTaskOperationError";
    this.operationCause = operationCause;
  }
}

function publicTaskOperationMessage(error: unknown, fallback: string): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TaskNotFoundError") return "Task not found.";
  if (name === "TaskQueueFullError" || name === "TaskStoreCapacityError") {
    return "The background task queue is full. Wait for retained work to finish or expire.";
  }
  if (name === "TaskSupervisorClosedError") return "The background task supervisor is unavailable.";
  return fallback;
}

function projectTaskList(records: TaskRecord[]): PublicTaskSnapshot[] {
  const queuePositions = new Map(
    records
      .filter((record) => record.status === "queued")
      .sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId))
      .map((record, index) => [record.taskId, index + 1]),
  );
  return records.map((record) => projectTaskSnapshot(record, {
    ...(queuePositions.has(record.taskId) ? { queuePosition: queuePositions.get(record.taskId) } : {}),
  }));
}

function mergeTaskRecords(records: TaskRecord[]): TaskRecord[] {
  const newestByTaskId = new Map<string, TaskRecord>();
  for (const record of records) {
    const existing = newestByTaskId.get(record.taskId);
    if (!existing || record.sequence > existing.sequence) newestByTaskId.set(record.taskId, record);
  }
  return [...newestByTaskId.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId),
  );
}

function notificationDigest(records: TaskRecord[]): string {
  const completed = records.filter((record) => record.status === "completed").length;
  const attention = records.length - completed;
  if (records.length === 1 && completed === 1) {
    return "Your background task is finished. The result is ready in the task inbox.";
  }
  if (records.length === 1) {
    return "A background task needs your attention. Open the task inbox for the exact status.";
  }
  if (attention === 0) {
    return `${records.length} background tasks are finished. Their results are ready in the task inbox.`;
  }
  return `${records.length} background tasks have updates: ${completed} finished and ${attention} need attention. Open the task inbox for details.`;
}

function validateAudioFrame(data: string, mimeType: string, maxBytes: number): void {
  if (!mimeType || mimeType.length > 128) throw new Error("Audio frame MIME type is invalid.");
  const decoded = decodeBase64Audio(data, maxBytes);
  if (decoded.length > maxBytes) throw new Error("Audio frame exceeds HERMES_LIVE_MAX_AUDIO_BYTES.");
  if (isPcmMimeType(mimeType)) {
    requirePcmSampleRate(mimeType);
    if (decoded.length % 2 !== 0) throw new Error("PCM16 audio frames must contain an even number of bytes.");
  }
}

function decodeBase64Audio(data: string, maxBytes: number): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 === 1) {
    throw new Error("Audio frame data must be base64 encoded.");
  }
  if (data.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new Error("Audio frame exceeds HERMES_LIVE_MAX_AUDIO_BYTES.");
  }
  return Buffer.from(data, "base64");
}

function validateText(value: string, maxChars: number, label: string): void {
  if (value.length > maxChars) throw new Error(`${label} exceeds HERMES_LIVE_MAX_TEXT_CHARS.`);
}

function clientInboundFrameBytes(frame: ClientInboundFrame): number {
  return typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.byteLength;
}

function requestIdFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return validatedRequestId((value as { id?: unknown }).id);
}

function validatedRequestId(value: unknown): string | undefined {
  const parsed = RequestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isPreemptiveClientControl(message: ClientMessage, sessionReady: boolean): boolean {
  if (message.type === "session.close") return true;
  return sessionReady && ["response.cancel", "task.stop"].includes(message.type);
}

function safetyIdentifierForSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex");
}

function stringArg(call: LiveToolCall, name: string): string {
  const value = call.args[name];
  return typeof value === "string" ? value.trim() : "";
}

function optionalStringArg(call: LiveToolCall, name: string): string | undefined {
  const value = stringArg(call, name);
  return value || undefined;
}

function booleanArg(call: LiveToolCall, name: string, fallback: boolean): boolean {
  const value = call.args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function executionModeArg(call: LiveToolCall): TaskExecutionMode {
  const value = call.args.execution_mode;
  if (value === undefined) return "exclusive";
  if (value !== "exclusive" && value !== "parallel_read_only") {
    throw new Error("execution_mode must be exclusive or parallel_read_only.");
  }
  return value;
}

function resourceKeysArg(call: LiveToolCall): string[] | undefined {
  const value = call.args.resource_keys;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TOOL_RESOURCE_KEYS) {
    throw new Error(`resource_keys must contain between 1 and ${MAX_TOOL_RESOURCE_KEYS} strings.`);
  }
  const keys = value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 256 || /[\u0000-\u001f\u007f]/u.test(item)) {
      throw new Error("resource_keys contains an invalid value.");
    }
    return item.trim();
  });
  return [...new Set(keys)];
}

function requireProviderToolCallId(call: LiveToolCall): string {
  if (!call.name || call.name.length > 128 || !/^[A-Za-z0-9_.:-]+$/u.test(call.name)) {
    throw new Error("Realtime provider emitted a tool call with an invalid name.");
  }
  if (!call.id || call.id.length > 256 || /[\u0000-\u001f\u007f]/u.test(call.id)) {
    throw new Error("Realtime provider emitted a tool call without a bounded id.");
  }
  return call.id;
}

function requireProviderToolCancellationId(value: string): string {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Realtime provider emitted a tool cancellation without a bounded id.");
  }
  return value;
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

function providerToolCallIdDigest(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

function boundedProviderToolResponse(response: Record<string, unknown>): Record<string, unknown> {
  return safeJsonByteLength(response) <= MAX_PROVIDER_TOOL_RESPONSE_BYTES
    ? response
    : { ok: false, error: "Task result exceeded the safe provider response limit." };
}

function publicHermesCapabilities(
  capabilities: Awaited<ReturnType<HermesRunsPort["capabilities"]>>,
): { model?: string; capabilities?: Record<string, unknown> } {
  const model = boundedDisplayText(capabilities.model, 256);
  const projected: Record<string, unknown> = {};
  const features = capabilities.features;
  if (features && typeof features === "object" && !Array.isArray(features)) {
    for (const key of [
      "run_submission",
      "run_status",
      "run_events_sse",
      "run_stop",
      "run_approval_response",
      "run_approval_response_by_id",
    ]) {
      if (typeof features[key] === "boolean") projected[key] = features[key];
    }
  }
  return {
    ...(model ? { model } : {}),
    ...(Object.keys(projected).length ? { capabilities: projected } : {}),
  };
}

function publicRealtimeStartupError(error: unknown, readyTimeoutMs: number): string {
  const message = errorToMessage(error);
  if (
    message.includes("Realtime provider did not") ||
    message === "Realtime provider session closed before ready." ||
    message === "Realtime provider exceeded the safe pre-ready event queue limit."
  ) {
    return boundedText(message, 500);
  }
  return `Realtime provider session failed to start within ${readyTimeoutMs}ms. Check the gateway logs.`;
}

function providerCloseLogDetail(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const code = (value as Record<string, unknown>).code;
  return typeof code === "number" && Number.isInteger(code) && code >= 1_000 && code <= 4_999
    ? { providerCode: code }
    : {};
}

function publicProviderIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return undefined;
  }
  return value;
}

function publicContentIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
}

function publicAudioStartMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60 * 60 * 1_000
    ? value
    : undefined;
}

function boundedDisplayText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const printable = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  return printable ? printable.slice(0, maximum) : undefined;
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function safeJsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
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
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason ?? new DOMException("Aborted", "AbortError"));
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
