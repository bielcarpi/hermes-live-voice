const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 1_000_000;
const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 8_000_000;
const DEFAULT_MAX_QUEUED_AUDIO_MS = 5_000;
const DEFAULT_MAX_QUEUED_AUDIO_FRAMES = 256;
const DEFAULT_PLAYBACK_RESUME_TIMEOUT_MS = 2_000;
const DEFAULT_SAMPLE_RATE = 24_000;
const MIN_PCM_SAMPLE_RATE = 8_000;
const MAX_PCM_SAMPLE_RATE = 192_000;
// Keep these public wire ceilings in lockstep with
// src/domain/protocol/server-protocol.ts. The total frame limit is a separate
// transport guard and does not replace per-field or retained-state bounds.
const PUBLIC_MODEL_MAX_CHARS = 256;
const PUBLIC_MIME_TYPE_MAX_CHARS = 128;
const PUBLIC_TRANSCRIPT_MAX_CHARS = 20_000;
const PUBLIC_TASK_TITLE_MAX_CHARS = 256;
const PUBLIC_TASK_PROGRESS_MAX_CHARS = 1_000;
const PUBLIC_TASK_SUMMARY_MAX_CHARS = 4_000;
const PUBLIC_TASK_OUTPUT_MAX_CHARS = 200_000;
const PUBLIC_TASK_ERROR_MAX_CHARS = 2_000;
const PUBLIC_NOTIFICATION_MAX_CHARS = 1_000;
const PUBLIC_LOG_MAX_CHARS = 2_000;
const PUBLIC_JSON_MAX_CHARS = 64_000;
// A JSON value whose serialized representation fits in 64k cannot legitimately
// exceed these structural ceilings. They let the exported validator reject
// adversarial direct-call objects before traversal becomes unbounded while
// preserving every value the wire schema accepts.
const PUBLIC_JSON_MAX_DEPTH = PUBLIC_JSON_MAX_CHARS;
const PUBLIC_JSON_MAX_KEYS = PUBLIC_JSON_MAX_CHARS;
const PUBLIC_JSON_MAX_NODES = PUBLIC_JSON_MAX_CHARS;
const PUBLIC_AUDIO_BASE64_MAX_CHARS = 8_000_000;
const PUBLIC_ERROR_CODE_MAX_CHARS = 128;
const PUBLIC_TASK_STAGE_MAX_CHARS = 128;
const PUBLIC_TASK_REASON_MAX_CHARS = 1_000;
const PUBLIC_CONVERSATION_TITLE_MAX_CHARS = 100;
const PUBLIC_CONVERSATION_PREVIEW_MAX_CHARS = 500;
const DEFAULT_TASK_LIST_LIMIT = 50;
const MAX_TASK_LIST_LIMIT = 100;
// Server configuration can retain history (1000) + queued work (512) +
// concurrent work (16). Keep one bounded client envelope above that maximum so
// reconnect hydration can never evict a task before its notification arrives.
const MAX_RETAINED_TASKS = 2_048;
const MAX_UNREAD_NOTIFICATIONS = 2_048;
// Full task output is independently bounded: retain every task shell and
// summary, but compact older large outputs once the detailed working set fills.
const MAX_RETAINED_TASK_OUTPUTS = 256;
const MAX_PENDING_REQUESTS = 256;
const TASK_EVENT_TYPES = new Set([
  "task.accepted",
  "task.started",
  "task.progress",
  "task.stopping",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.unknown",
  "task.notification",
]);
const ACTIVE_TASK_STATES = new Set([
  "accepted",
  "queued",
  "running",
  "stopping",
  "unknown",
]);
const TASK_STOP_RESPONSE_TYPES = new Set([
  "task.stopping",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.unknown",
]);
const OPEN = 1;
export const HERMES_LIVE_PROTOCOL_VERSION = 4;

const KNOWN_SERVER_MESSAGE_TYPES = new Set([
  "session.ready",
  "session.error",
  "audio.output",
  "transcript.delta",
  "input.speech_started",
  "response.started",
  "response.completed",
  "response.cancelled",
  "response.failed",
  "task.snapshot",
  "task.accepted",
  "task.started",
  "task.progress",
  "task.stopping",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.unknown",
  "task.notification",
  "log",
]);

class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(type, listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Hermes Live listeners must be functions.");
    }
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(type);
    };
  }

  emit(type, value) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      try {
        listener(value);
      } catch (error) {
        if (type !== "listener.error") this.emit("listener.error", { type, error: toError(error) });
      }
    }
  }

  clear() {
    this.listeners.clear();
  }
}

/**
 * Framework-independent client for the Hermes Live Voice WebSocket protocol.
 * It has no Node, DOM, framework, or provider SDK dependencies.
 */
export class HermesLiveClient {
  #tokenProvider;

  constructor(options = {}) {
    if (!options.url && !options.webSocketUrlProvider) {
      throw new TypeError("HermesLiveClient requires a gateway URL or webSocketUrlProvider.");
    }
    this.configuredUrl = options.url ? normalizeGatewayWebSocketUrl(options.url) : undefined;
    this.webSocketUrlProvider = options.webSocketUrlProvider;
    this.#tokenProvider = options.token;
    this.profileId = optionalString(options.profileId);
    this.userLabel = optionalString(options.userLabel);
    this.conversation = normalizeConversationSelection(options.conversation ?? { mode: "new" });
    this.connectTimeoutMs = positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.disconnectTimeoutMs = positiveInteger(options.disconnectTimeoutMs, DEFAULT_DISCONNECT_TIMEOUT_MS);
    this.maxBufferedAmountBytes = positiveInteger(
      options.maxBufferedAmountBytes,
      DEFAULT_MAX_BUFFERED_AMOUNT_BYTES,
    );
    this.maxInboundMessageBytes = positiveInteger(
      options.maxInboundMessageBytes,
      DEFAULT_MAX_INBOUND_MESSAGE_BYTES,
    );
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.requestIdFactory = options.requestIdFactory ?? defaultRequestId;
    this.emitter = new Emitter();
    this.socket = undefined;
    this.connectPromise = undefined;
    this.messageChain = Promise.resolve();
    this.session = undefined;
    this.sessionStartRequestId = undefined;
    this.reconnectSnapshotPending = false;
    this.taskMap = new Map();
    this.taskLifecycleSequenceMap = new Map();
    this.taskLifecycleRevisionMap = new Map();
    this.unreadNotificationMap = new Map();
    this.notificationRevisionMap = new Map();
    this.pendingRequests = new Map();
    this.state = "idle";
    this.generation = 0;
    this.snapshot = createSnapshot("idle");
  }

  on(type, listener) {
    return this.emitter.on(type, listener);
  }

  subscribe(listener) {
    return this.emitter.on("snapshot", listener);
  }

  getSnapshot() {
    return this.snapshot;
  }

  get connected() {
    return this.state === "ready" && this.socket?.readyState === OPEN;
  }

  get tasks() {
    return this.snapshot.tasks;
  }

  get activeTasks() {
    return this.snapshot.activeTasks;
  }

  get recentTasks() {
    return this.snapshot.recentTasks;
  }

  async connect(options = {}) {
    if (this.connected && this.session) return this.session;
    if (this.connectPromise) return this.connectPromise;
    if (options.signal?.aborted) throw abortError();

    const generation = ++this.generation;
    this.setState("connecting");
    const conversation = normalizeConversationSelection(options.conversation ?? this.conversation);
    const attempt = this.openConnection(generation, options.signal, conversation);
    this.connectPromise = attempt;
    try {
      return await attempt;
    } catch (error) {
      if (generation === this.generation && this.state !== "closed") this.setState("failed");
      throw error;
    } finally {
      if (this.connectPromise === attempt) this.connectPromise = undefined;
    }
  }

  async openConnection(generation, signal, conversation) {
    const startedAt = Date.now();
    let socketUrl;
    try {
      socketUrl = await settleConnectionPrerequisite(
        this.resolveSocketUrl(),
        this.connectTimeoutMs,
        signal,
      );
    } catch (error) {
      const normalized = toError(error);
      if (normalized.name !== "AbortError") this.emitError(normalized, "url_resolution_failed");
      throw normalized;
    }
    if (generation !== this.generation) throw abortError();
    if (signal?.aborted) throw abortError();

    let socket;
    try {
      socket = this.webSocketFactory(socketUrl);
    } catch (error) {
      const normalized = toError(error);
      this.emitError(normalized, "websocket_create_failed");
      throw normalized;
    }
    this.socket = socket;
    this.messageChain = Promise.resolve();

    return await new Promise((resolve, reject) => {
      let settled = false;
      let ready = false;
      let fatalServerErrorReceived = false;
      const finish = (error, session) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(session);
      };
      const failStartup = (error, code) => {
        const normalized = toError(error);
        this.emitError(normalized, code);
        finish(normalized);
      };
      const remainingTimeoutMs = Math.max(1, this.connectTimeoutMs - (Date.now() - startedAt));
      const timeout = setTimeout(() => {
        const error = new Error(`Hermes Live session did not become ready within ${this.connectTimeoutMs}ms.`);
        failStartup(error, "connect_timeout");
        closeSocket(socket, 4000, "session ready timeout");
      }, remainingTimeoutMs);
      const onAbort = () => {
        const error = abortError();
        finish(error);
        closeSocket(socket, 1000, "connection cancelled");
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      socket.addEventListener("open", () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        try {
          this.setState("starting");
          const requestId = this.createRequestId();
          this.sessionStartRequestId = requestId;
          this.sendRaw({
            type: "session.start",
            id: requestId,
            protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
            ...(this.profileId ? { profileId: this.profileId } : {}),
            ...(this.userLabel ? { userLabel: this.userLabel } : {}),
            conversation,
          });
        } catch (error) {
          failStartup(error, "session_start_send_failed");
          closeSocket(socket, 1011, "session start failed");
        }
      });

      socket.addEventListener("message", (event) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.messageChain = this.messageChain
          .then(async () => {
            if (!this.isCurrentSocket(socket, generation)) return;
            const message = await this.decodeMessage(event.data);
            if (!this.isCurrentSocket(socket, generation)) return;
            this.acceptMessage(message);
            if (message.type === "session.ready") {
              ready = true;
              finish(undefined, message);
            } else if (message.type === "session.error" && !ready) {
              const error = new Error(message.message || "Hermes Live session failed to start.");
              finish(error);
              closeSocket(socket, 1008, "session startup rejected");
            } else if (message.type === "session.error" && message.recoverable === false) {
              fatalServerErrorReceived = true;
              this.setState("failed");
              closeSocket(socket, 1011, "nonrecoverable session error");
            }
          })
          .catch((error) => {
            const normalized = toError(error);
            this.emitError(normalized, "invalid_server_message");
            finish(normalized);
            closeSocket(socket, 1003, "invalid server message");
          });
      });

      socket.addEventListener("error", () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        const error = new Error(
          "Hermes Live WebSocket failed. Check the gateway URL, authentication, TLS, and allowed origin.",
        );
        this.emitError(error, "websocket_error");
        if (!ready) finish(error);
      });

      socket.addEventListener("close", (event) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.socket = undefined;
        this.session = undefined;
        this.sessionStartRequestId = undefined;
        this.reconnectSnapshotPending = false;
        this.pendingRequests.clear();
        this.updateSnapshot({ session: undefined });
        this.setState("closed");
        const closeEvent = {
          code: Number(event.code ?? 1006),
          reason: String(event.reason ?? ""),
          clean: Boolean(event.wasClean),
        };
        this.emitter.emit("close", closeEvent);
        if (!ready) {
          finish(new Error(`Hermes Live connection closed before session readiness (${closeEvent.code}).`));
        } else if (!closeEvent.clean && closeEvent.code !== 1000 && !fatalServerErrorReceived) {
          this.emitError(new Error("Hermes Live connection was lost."), "connection_lost", closeEvent);
        }
      });
    });
  }

  async resolveSocketUrl() {
    const ephemeral = Boolean(this.webSocketUrlProvider);
    const provided = ephemeral ? await this.webSocketUrlProvider() : this.configuredUrl;
    if (!provided) throw new Error("Hermes Live WebSocket URL provider returned no URL.");
    const token = typeof this.#tokenProvider === "function"
      ? await this.#tokenProvider()
      : this.#tokenProvider;
    const url = ephemeral
      ? new URL(normalizeWebSocketUrl(provided, { allowTokenQuery: true }))
      : new URL(normalizeGatewayWebSocketUrl(provided));
    const normalizedToken = String(token ?? "").trim();
    if (normalizedToken) url.searchParams.set("token", normalizedToken);
    return url;
  }

  async disconnect(reason = "user disconnected") {
    const socket = this.socket;
    if (!socket) {
      ++this.generation;
      this.session = undefined;
      this.sessionStartRequestId = undefined;
      this.reconnectSnapshotPending = false;
      this.pendingRequests.clear();
      this.updateSnapshot({ session: undefined });
      this.setState("closed");
      return;
    }
    this.setState("closing");
    this.updateSnapshot({ lastError: undefined });
    let requestedProtocolClose = false;
    if (socket.readyState === OPEN) {
      try {
        this.sendRaw({ type: "session.close", id: this.createRequestId(), detach: true });
        requestedProtocolClose = true;
      } catch {
        // Fall back to a local WebSocket close below.
      }
    }
    let closeObserved = false;
    let closeTimedOut = false;
    let observedClose;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        closeTimedOut = true;
        closeSocket(socket, 4000, "gateway close confirmation timeout");
        resolve();
      }, requestedProtocolClose ? this.disconnectTimeoutMs : 1_000);
      socket.addEventListener("close", (event) => {
        closeObserved = true;
        observedClose = {
          code: Number(event.code ?? 1006),
          reason: String(event.reason ?? ""),
          clean: Boolean(event.wasClean),
        };
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      if (!requestedProtocolClose) closeSocket(socket, 1000, reason);
    });
    if (!closeObserved && this.isCurrentSocket(socket, this.generation)) {
      ++this.generation;
      this.socket = undefined;
      this.session = undefined;
      this.sessionStartRequestId = undefined;
      this.reconnectSnapshotPending = false;
      this.pendingRequests.clear();
      this.updateSnapshot({ session: undefined });
      this.setState("closed");
      this.emitter.emit("close", {
        code: 1006,
        reason: "disconnect timed out",
        clean: false,
      });
    }
    if (closeTimedOut) {
      throw new Error("The gateway did not confirm session detach; verify background task state after reconnecting.");
    }
    await this.messageChain.catch(() => undefined);
    if (observedClose && (observedClose.code !== 1000 || !observedClose.clean)) {
      throw new Error(
        this.snapshot.lastError?.error?.message ||
        "The gateway closed abnormally and did not confirm session detach. Verify background task state after reconnecting.",
      );
    }
  }

  sendText(text, options = {}) {
    const normalized = String(text ?? "").trim();
    if (!normalized) throw new TypeError("Hermes Live text input cannot be empty.");
    const id = options.id ?? this.createRequestId();
    this.send({ type: "text.input", id, text: normalized });
    return id;
  }

  sendAudio(data, mimeType = `audio/pcm;rate=${DEFAULT_SAMPLE_RATE}`, options = {}) {
    const id = options.id ?? this.createRequestId();
    if ((this.socket?.bufferedAmount ?? 0) > this.maxBufferedAmountBytes) {
      this.emitter.emit("audio.dropped", {
        id,
        direction: "input",
        reason: "websocket_backpressure",
        bufferedAmount: this.socket?.bufferedAmount ?? 0,
      });
      return undefined;
    }
    const base64 = typeof data === "string" ? data : arrayBufferToBase64(data);
    if (!base64) throw new TypeError("Hermes Live audio input cannot be empty.");
    this.send({ type: "audio.input", id, data: base64, mimeType });
    return id;
  }

  endAudio(options = {}) {
    const id = options.id ?? this.createRequestId();
    this.send({ type: "audio.end", id });
    return id;
  }

  cancelResponse(reason = "user interrupted", truncate, options = {}) {
    const id = options.id ?? this.createRequestId();
    this.send({ type: "response.cancel", id, reason, ...(truncate ? { truncate } : {}) });
    return id;
  }

  listTasks(options = {}) {
    const limit = options.limit ?? DEFAULT_TASK_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_LIST_LIMIT) {
      throw new TypeError(`Hermes Live task list limit must be between 1 and ${MAX_TASK_LIST_LIMIT}.`);
    }
    const id = options.id ?? this.createRequestId();
    return this.sendCorrelated(
      { type: "task.list", id, limit },
      { type: "task.list" },
    );
  }

  getTask(taskId, options = {}) {
    const normalizedTaskId = requireClientId(taskId, "taskId");
    const id = options.id ?? this.createRequestId();
    return this.sendCorrelated(
      { type: "task.get", id, taskId: normalizedTaskId },
      { type: "task.get", taskId: normalizedTaskId },
    );
  }

  followUpTask(taskId, message, options = {}) {
    const normalizedTaskId = requireClientId(taskId, "taskId");
    const normalizedMessage = String(message ?? "").trim();
    if (!normalizedMessage) throw new TypeError("Hermes Live task follow-up cannot be empty.");
    const title = optionalBoundedString(options.title, PUBLIC_TASK_TITLE_MAX_CHARS, "task follow-up title")?.trim();
    if (options.title !== undefined && !title) throw new TypeError("Hermes Live task follow-up title cannot be empty.");
    const id = options.id ?? this.createRequestId();
    return this.sendCorrelated(
      {
        type: "task.follow_up",
        id,
        taskId: normalizedTaskId,
        message: normalizedMessage,
        ...(title ? { title } : {}),
      },
      { type: "task.follow_up", taskId: normalizedTaskId },
    );
  }

  stopTask(taskId, reason = "user stopped background task", options = {}) {
    const normalizedTaskId = requireClientId(taskId, "taskId");
    const task = this.taskMap.get(normalizedTaskId);
    if (!task) throw new Error(`Hermes Live does not know task ${normalizedTaskId}; refresh tasks before stopping it.`);
    if (task.state === "stopping") {
      throw new Error(`Hermes Live task ${normalizedTaskId} is not stoppable from state ${task.state}.`);
    }
    const normalizedReason = optionalBoundedString(reason, 1_000, "task stop reason");
    const id = options.id ?? this.createRequestId();
    return this.sendCorrelated(
      {
        type: "task.stop",
        id,
        taskId: normalizedTaskId,
        ...(normalizedReason === undefined ? {} : { reason: normalizedReason }),
      },
      { type: "task.stop", taskId: normalizedTaskId },
    );
  }

  acknowledgeNotification(taskId, notificationId, options = {}) {
    const normalizedTaskId = requireClientId(taskId, "taskId");
    const normalizedNotificationId = requireClientId(notificationId, "notificationId");
    const notification = this.unreadNotificationMap.get(
      notificationKey(normalizedTaskId, normalizedNotificationId),
    );
    if (!notification) {
      throw new Error("Hermes Live can only acknowledge the exact unread task notification currently in client state.");
    }
    const id = options.id ?? this.createRequestId();
    return this.sendCorrelated(
      {
        type: "task.notification.ack",
        id,
        taskId: normalizedTaskId,
        notificationId: normalizedNotificationId,
      },
      {
        type: "task.notification.ack",
        taskId: normalizedTaskId,
        notificationId: normalizedNotificationId,
      },
    );
  }

  sendMessage(message) {
    if ([
      "task.list",
      "task.get",
      "task.follow_up",
      "task.stop",
      "task.notification.ack",
      "session.close",
    ].includes(message.type)) {
      throw new Error(`Use the dedicated HermesLiveClient API for ${message.type} so its response is safely correlated.`);
    }
    const id = message.id ?? this.createRequestId();
    this.send({ ...message, id });
    return id;
  }

  sendCorrelated(message, pending) {
    const id = requireClientId(message.id, "request id", 128);
    if (this.pendingRequests.has(id)) {
      throw new Error(`Hermes Live request ID ${id} is already pending.`);
    }
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      throw new Error("Hermes Live exceeded the safe pending request limit.");
    }
    this.pendingRequests.set(id, pending);
    try {
      this.send({ ...message, id });
    } catch (error) {
      this.pendingRequests.delete(id);
      throw error;
    }
    return id;
  }

  send(message) {
    if (!this.connected) throw new Error("Connect to Hermes Live before sending messages.");
    this.sendRaw(message);
  }

  sendRaw(message) {
    if (!this.socket || this.socket.readyState !== OPEN) {
      throw new Error("Hermes Live WebSocket is not open.");
    }
    this.socket.send(JSON.stringify(message));
  }

  async decodeMessage(data) {
    if (encodedMessageSize(data) > this.maxInboundMessageBytes) {
      throw new Error("Hermes Live server message exceeded the configured client limit.");
    }
    let text;
    if (typeof data === "string") {
      text = data;
    } else if (data && typeof data.text === "function") {
      text = await data.text();
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else {
      throw new TypeError("Hermes Live returned an unsupported WebSocket message type.");
    }
    if (encodedMessageSize(text) > this.maxInboundMessageBytes) {
      throw new Error("Hermes Live server message exceeded the configured client limit.");
    }
    return validateServerMessage(JSON.parse(text));
  }

  acceptMessage(message) {
    let applied = true;
    switch (message.type) {
      case "session.ready":
        if (
          message.requestId &&
          this.sessionStartRequestId &&
          message.requestId !== this.sessionStartRequestId
        ) {
          throw new Error("Hermes Live session.ready did not match the active session.start request.");
        }
        this.sessionStartRequestId = undefined;
        this.session = message;
        if (message.conversation?.sessionId) {
          this.conversation = { mode: "resume", sessionId: message.conversation.sessionId };
        }
        this.reconnectSnapshotPending = true;
        this.setState("ready");
        this.updateSnapshot({ session: message, lastError: undefined });
        break;
      case "task.snapshot":
        applied = this.acceptTaskSnapshot(message);
        break;
      case "session.error":
        if (
          !this.session &&
          message.requestId &&
          this.sessionStartRequestId &&
          message.requestId !== this.sessionStartRequestId
        ) {
          throw new Error("Hermes Live startup error did not match the active session.start request.");
        }
        if (message.requestId && this.pendingRequests.has(message.requestId)) {
          const request = this.pendingRequests.get(message.requestId);
          this.pendingRequests.delete(message.requestId);
          this.emitter.emit("request.failed", { requestId: message.requestId, request, error: message });
        }
        this.emitError(new Error(message.message), message.code, message);
        break;
      default:
        if (TASK_EVENT_TYPES.has(message.type)) applied = this.acceptTaskEvent(message);
    }
    this.emitter.emit("message", message);
    if (KNOWN_SERVER_MESSAGE_TYPES.has(message.type)) {
      if (applied) this.emitter.emit(message.type, message);
    }
    else this.emitter.emit("unknownmessage", message);
  }

  acceptTaskSnapshot(message) {
    let pending;
    if (message.reason === "list" || message.reason === "get") {
      pending = this.requirePendingRequest(
        message.requestId,
        message.reason === "list" ? "task.list" : "task.get",
      );
      if (
        message.reason === "get" &&
        message.tasks[0] &&
        message.tasks[0].taskId !== pending.taskId
      ) {
        throw new Error("Hermes Live task.get snapshot did not match its requested taskId.");
      }
      this.pendingRequests.delete(message.requestId);
      this.emitter.emit("request.succeeded", {
        requestId: message.requestId,
        request: pending,
        response: message,
      });
    }

    const reconnectReconciliation = message.reason === "initial" || message.reason === "reconnect";
    const firstReconnectSnapshot = reconnectReconciliation && this.reconnectSnapshotPending;
    if (firstReconnectSnapshot) {
      this.reconnectSnapshotPending = false;
      this.unreadNotificationMap.clear();
      this.notificationRevisionMap.clear();
      // A reconnect hydration is authoritative for retained client state: it
      // includes recent history plus every active/unread record, possibly over
      // several bounded frames. Clearing once prevents older read history from
      // accumulating forever while subsequent frames merge normally.
      this.taskMap.clear();
      this.taskLifecycleSequenceMap.clear();
      this.taskLifecycleRevisionMap.clear();
    }

    for (const task of message.tasks) {
      const existing = this.taskMap.get(task.taskId);
      const lifecycleSequence = this.taskLifecycleSequenceMap.get(task.taskId) ?? existing?.sequence ?? 0;
      if (existing && task.sequence < existing.sequence && task.sequence <= lifecycleSequence) {
        this.emitter.emit("task.stale", {
          taskId: task.taskId,
          type: message.type,
          sequence: task.sequence,
          currentSequence: existing.sequence,
        });
        continue;
      }
      if (existing && task.sequence === lifecycleSequence) {
        const retainedRevision = this.taskLifecycleRevisionMap.get(task.taskId);
        if (
          retainedRevision &&
          (
            retainedRevision.createdAt !== task.createdAt ||
            retainedRevision.updatedAt !== task.updatedAt
          )
        ) {
          throw new Error("Hermes Live received conflicting lifecycle timestamps at one task sequence.");
        }
        assertCompatibleTaskRevision(existing, task);
        this.retainTask(mergeEqualSequenceTask(existing, task));
        if (!retainedRevision) {
          this.retainTaskLifecycleRevision(task.taskId, {
            sequence: task.sequence,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
          });
        }
        continue;
      }
      this.retainTask(existing && task.sequence < existing.sequence
        ? mergeNewerLifecycleSnapshot(existing, task)
        : task);
      this.taskLifecycleSequenceMap.set(task.taskId, task.sequence);
      this.retainTaskLifecycleRevision(task.taskId, {
        sequence: task.sequence,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    }
    this.syncTaskSnapshot();
    if (reconnectReconciliation) {
      this.emitter.emit("notifications.changed", this.snapshot.unreadNotifications);
    }
    this.emitter.emit("tasks.reconciled", {
      reason: message.reason,
      requestId: message.requestId,
      tasks: this.snapshot.tasks,
      truncated: message.truncated,
    });
    return true;
  }

  acceptTaskEvent(message) {
    const existing = this.taskMap.get(message.taskId);
    const eventFingerprint = taskEventFingerprint(message);
    const notificationRevision = message.type === "task.notification"
      ? this.notificationRevisionMap.get(message.taskId)
      : undefined;
    const lifecycleRevision = message.type === "task.notification"
      ? undefined
      : this.taskLifecycleRevisionMap.get(message.taskId);
    const lifecycleSequence = this.taskLifecycleSequenceMap.get(message.taskId) ?? existing?.sequence ?? 0;
    if (
      notificationRevision &&
      message.sequence === notificationRevision.sequence &&
      eventFingerprint !== notificationRevision.fingerprint
    ) {
      throw new Error("Hermes Live received conflicting notification state at one task sequence.");
    }
    if (
      lifecycleRevision &&
      message.sequence === lifecycleRevision.sequence &&
      (
        (lifecycleRevision.fingerprint && eventFingerprint !== lifecycleRevision.fingerprint) ||
        lifecycleRevision.updatedAt !== message.occurredAt
      )
    ) {
      throw new Error("Hermes Live received conflicting lifecycle content at one task sequence.");
    }
    if (
      message.type !== "task.notification" &&
      message.sequence === lifecycleSequence &&
      !lifecycleRevision?.fingerprint
    ) {
      if (existing) assertCompatibleTaskRevision(existing, taskFromLifecycle(existing, message));
      this.retainTaskLifecycleRevision(message.taskId, {
        sequence: message.sequence,
        fingerprint: eventFingerprint,
        createdAt: lifecycleRevision?.createdAt ?? existing?.createdAt ?? message.occurredAt,
        updatedAt: lifecycleRevision?.updatedAt ?? message.occurredAt,
      });
    }
    const stale = message.type === "task.notification"
      ? Boolean(
          (notificationRevision && message.sequence <= notificationRevision.sequence) ||
          (existing && message.sequence < existing.sequence),
        )
      : Boolean(existing && message.sequence <= lifecycleSequence);
    this.correlateTaskMutation(message, stale);
    if (stale) {
      this.emitter.emit("task.stale", {
        taskId: message.taskId,
        type: message.type,
        sequence: message.sequence,
        currentSequence: Math.max(existing?.sequence ?? 0, notificationRevision?.sequence ?? 0),
      });
      return false;
    }
    if (!existing && message.type !== "task.accepted") {
      throw new Error(`Hermes Live rejected ${message.type} for unknown task ${message.taskId}.`);
    }

    let task = message.type === "task.notification"
      ? nextTaskSnapshot(existing, message, {})
      : taskFromLifecycle(existing, message);
    if (message.type === "task.notification") {
        const key = notificationKey(message.taskId, message.notification.notificationId);
        this.retainNotificationRevision(message.taskId, {
          notificationId: message.notification.notificationId,
          sequence: message.sequence,
          acknowledged: message.notification.acknowledged,
          fingerprint: eventFingerprint,
        });
        // One durable task has exactly one current notification identity. A
        // later terminal resolution (for example unknown -> cancelled) creates
        // a new identity, so withdraw the obsolete inbox item before exposing
        // the replacement. Retain the current revision separately to reject
        // conflicting equal-sequence replays.
        for (const [retainedKey, retained] of this.unreadNotificationMap) {
          if (retained.taskId === message.taskId && retainedKey !== key) {
            this.unreadNotificationMap.delete(retainedKey);
          }
        }
        if (message.notification.acknowledged) {
          this.unreadNotificationMap.delete(key);
        } else {
          this.retainUnreadNotification({ taskId: message.taskId, ...message.notification });
        }
    }
    this.retainTask(task);
    if (message.type !== "task.notification") {
      this.taskLifecycleSequenceMap.set(message.taskId, message.sequence);
      this.retainTaskLifecycleRevision(message.taskId, {
        sequence: message.sequence,
        fingerprint: eventFingerprint,
        createdAt: task.createdAt,
        updatedAt: message.occurredAt,
      });
    }
    this.syncTaskSnapshot();
    this.emitter.emit("task.updated", { task, message });
    if (message.type === "task.notification") {
      this.emitter.emit("notifications.changed", this.snapshot.unreadNotifications);
    }
    return true;
  }

  correlateTaskMutation(message, stale) {
    let expected;
    if (TASK_STOP_RESPONSE_TYPES.has(message.type) && message.requestId) {
      expected = { type: "task.stop", taskId: message.taskId };
    } else if (
      message.type === "task.accepted" &&
      message.requestId &&
      this.pendingRequests.get(message.requestId)?.type === "task.stop"
    ) {
      expected = { type: "task.stop", taskId: message.taskId };
    } else if (
      message.type === "task.accepted" &&
      message.requestId &&
      this.pendingRequests.get(message.requestId)?.type === "task.follow_up"
    ) {
      expected = { type: "task.follow_up" };
    } else if (message.type === "task.notification" && message.requestId) {
      expected = {
        type: "task.notification.ack",
        taskId: message.taskId,
        notificationId: message.notification.notificationId,
      };
      if (!message.notification.acknowledged) {
        throw new Error("Hermes Live notification acknowledgement response was not acknowledged.");
      }
    }
    if (!expected) return;
    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      if (stale) return;
      throw new Error(`Hermes Live received uncorrelated ${message.type} request ${message.requestId}.`);
    }
    assertRequestMatches(pending, expected, message.type);
    this.pendingRequests.delete(message.requestId);
    this.emitter.emit("request.succeeded", {
      requestId: message.requestId,
      request: pending,
      response: message,
    });
  }

  requirePendingRequest(requestId, type) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) throw new Error(`Hermes Live received uncorrelated ${type} response ${requestId}.`);
    assertRequestMatches(pending, { type }, `${type} response`);
    return pending;
  }

  retainTask(task) {
    const frozen = freezeTaskSnapshot(task);
    if (!this.taskMap.has(frozen.taskId) && this.taskMap.size >= MAX_RETAINED_TASKS) {
      throw new Error("Hermes Live exceeded the safe retained task limit.");
    }
    this.taskMap.set(frozen.taskId, frozen);
    this.compactRetainedTaskOutputs(frozen.taskId);
  }

  retainUnreadNotification(notification) {
    const key = notificationKey(notification.taskId, notification.notificationId);
    if (!this.unreadNotificationMap.has(key) && this.unreadNotificationMap.size >= MAX_UNREAD_NOTIFICATIONS) {
      throw new Error("Hermes Live exceeded the safe retained unread notification limit.");
    }
    this.unreadNotificationMap.set(key, Object.freeze({ ...notification }));
  }

  compactRetainedTaskOutputs(preferredTaskId) {
    const detailed = [...this.taskMap.values()]
      .filter((candidate) => candidate.result?.output !== undefined)
      .sort(compareTaskOldestFirst);
    while (detailed.length > MAX_RETAINED_TASK_OUTPUTS) {
      const compactIndex = detailed.findIndex((candidate) => candidate.taskId !== preferredTaskId);
      const [candidate] = detailed.splice(compactIndex >= 0 ? compactIndex : 0, 1);
      if (!candidate?.result) continue;
      const { output: _output, ...retainedResult } = candidate.result;
      this.taskMap.set(candidate.taskId, freezeTaskSnapshot({
        ...candidate,
        result: { ...retainedResult, truncated: true },
      }));
    }
  }

  retainNotificationRevision(taskId, revision) {
    if (!this.notificationRevisionMap.has(taskId) && this.notificationRevisionMap.size >= MAX_RETAINED_TASKS) {
      throw new Error("Hermes Live exceeded the safe retained notification revision limit.");
    }
    this.notificationRevisionMap.set(taskId, Object.freeze({ ...revision }));
  }

  retainTaskLifecycleRevision(taskId, revision) {
    if (!this.taskLifecycleRevisionMap.has(taskId) && this.taskLifecycleRevisionMap.size >= MAX_RETAINED_TASKS) {
      throw new Error("Hermes Live exceeded the safe retained lifecycle revision limit.");
    }
    this.taskLifecycleRevisionMap.set(taskId, Object.freeze({ ...revision }));
  }

  syncTaskSnapshot() {
    const tasks = Object.freeze([...this.taskMap.values()].sort(compareTaskNewestFirst));
    const activeTasks = Object.freeze(
      tasks.filter((task) => ACTIVE_TASK_STATES.has(task.state)).sort(compareTaskOldestFirst),
    );
    const recentTasks = Object.freeze(tasks.filter((task) => !ACTIVE_TASK_STATES.has(task.state)));
    const unreadNotifications = Object.freeze(
      [...this.unreadNotificationMap.values()].sort((left, right) => right.createdAt - left.createdAt),
    );
    this.updateSnapshot({ tasks, activeTasks, recentTasks, unreadNotifications });
    this.emitter.emit("tasks.changed", { tasks, activeTasks, recentTasks });
  }

  isCurrentSocket(socket, generation) {
    return this.socket === socket && this.generation === generation;
  }

  createRequestId() {
    const id = String(this.requestIdFactory());
    try {
      return requireClientId(id, "requestId", 128);
    } catch {
      throw new Error("Hermes Live requestIdFactory returned an invalid ID.");
    }
  }

  setState(next) {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    this.snapshot = Object.freeze({ ...this.snapshot, connection: next });
    const event = { state: next, previous };
    this.emitter.emit("statechange", event);
    this.emitter.emit("state", event);
    this.emitter.emit("snapshot", this.snapshot);
  }

  updateSnapshot(patch) {
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch });
    this.emitter.emit("snapshot", this.snapshot);
  }

  emitError(error, code, detail) {
    const event = { error, code, ...(detail === undefined ? {} : { detail }) };
    this.snapshot = Object.freeze({ ...this.snapshot, lastError: event });
    this.emitter.emit("error", event);
    this.emitter.emit("snapshot", this.snapshot);
  }
}

/**
 * Browser microphone capture and bounded PCM16 playback for HermesLiveClient.
 * Browser primitives are injectable for deterministic tests and alternative hosts.
 */
export class HermesLiveAudio {
  constructor(client, options = {}) {
    if (!(client instanceof HermesLiveClient) && typeof client?.sendAudio !== "function") {
      throw new TypeError("HermesLiveAudio requires a HermesLiveClient-compatible instance.");
    }
    this.client = client;
    this.workletUrl = options.workletUrl ?? "/mic-worklet.js";
    this.sampleRate = positiveInteger(options.sampleRate, DEFAULT_SAMPLE_RATE);
    this.maxQueuedAudioMs = positiveInteger(options.maxQueuedAudioMs, DEFAULT_MAX_QUEUED_AUDIO_MS);
    this.maxQueuedAudioFrames = positiveInteger(
      options.maxQueuedAudioFrames,
      DEFAULT_MAX_QUEUED_AUDIO_FRAMES,
    );
    this.playbackResumeTimeoutMs = positiveInteger(
      options.playbackResumeTimeoutMs,
      DEFAULT_PLAYBACK_RESUME_TIMEOUT_MS,
    );
    this.mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    this.audioContextFactory = options.audioContextFactory ?? ((config) => new AudioContext(config));
    this.audioWorkletNodeFactory = options.audioWorkletNodeFactory ??
      ((context, name, nodeOptions) => new AudioWorkletNode(context, name, nodeOptions));
    this.decodeBase64 = options.decodeBase64 ?? ((value) => atob(value));
    this.emitter = new Emitter();
    this.captureContext = undefined;
    this.captureSource = undefined;
    this.mediaStream = undefined;
    this.workletNode = undefined;
    this.microphoneState = "idle";
    this.captureGeneration = 0;
    this.microphoneStartPromise = undefined;
    this.microphoneStartCancellation = undefined;
    this.microphoneStopPromise = undefined;
    this.disposed = false;
    this.playbackContext = undefined;
    this.playbackCursor = 0;
    this.playbackSources = new Set();
    this.playbackItems = new Map();
    this.playbackChain = Promise.resolve();
    this.pendingPlaybackMs = 0;
    this.pendingPlaybackFrames = 0;
    this.playbackGeneration = 0;
    this.playbackEpoch = createPlaybackEpoch();
    this.playbackSuppressed = false;
    this.playbackResumeContext = undefined;
    this.playbackResumePromise = undefined;
    this.cancelPlaybackResume = undefined;
    this.unsubscribeClose = client.on?.("close", () => void this.dispose());
    this.unsubscribeResponseStarted = client.on?.("response.started", () => {
      this.playbackSuppressed = false;
    });
    this.unsubscribeResponseCancelled = client.on?.("response.cancelled", () => this.clearPlayback());
    this.unsubscribeResponseFailed = client.on?.("response.failed", () => this.clearPlayback());
  }

  on(type, listener) {
    return this.emitter.on(type, listener);
  }

  get microphoneActive() {
    return this.microphoneState === "active";
  }

  async primePlayback() {
    if (this.disposed) throw new Error("Hermes Live audio has been disposed.");
    const context = this.ensurePlaybackContext();
    if (context.state !== "running") await this.resumePlaybackContext(context);
    if (context.state !== "running") {
      throw new Error("Browser audio playback is unavailable. Allow audio, then try again from a user gesture.");
    }
  }

  async startMicrophone() {
    if (this.disposed) throw new Error("Hermes Live audio has been disposed.");
    if (this.microphoneState === "active") return;
    if (this.microphoneStartPromise) return this.microphoneStartPromise;
    if (this.microphoneStopPromise) await this.microphoneStopPromise;
    if (!this.client.connected) throw new Error("Connect to Hermes Live before starting the microphone.");
    if (!this.mediaDevices?.getUserMedia) throw new Error("This browser does not provide microphone access.");
    const negotiatedInput = this.client.session?.realtime?.audio?.input;
    if (negotiatedInput?.enabled === false) {
      throw new Error("This Hermes Live provider session does not accept microphone audio.");
    }
    if (negotiatedInput?.mimeType && !isPcmMimeType(negotiatedInput.mimeType)) {
      throw new Error(
        `Hermes Live browser microphone supports PCM16 input, not ${negotiatedInput.mimeType}. Configure the gateway for PCM16.`,
      );
    }

    this.interrupt("microphone started");
    const generation = ++this.captureGeneration;
    const cancellation = createCaptureCancellation();
    this.setMicrophoneState("starting");
    const start = this.startMicrophonePipeline(generation, negotiatedInput, cancellation);
    this.microphoneStartCancellation = cancellation;
    this.microphoneStartPromise = start;
    try {
      await start;
    } finally {
      if (this.microphoneStartPromise === start) this.microphoneStartPromise = undefined;
      if (this.microphoneStartCancellation === cancellation) this.microphoneStartCancellation = undefined;
    }
  }

  async startMicrophonePipeline(generation, negotiatedInput, cancellation) {
    let stream;
    let context;
    let source;
    let node;
    try {
      stream = await capturePrerequisite(
        this.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        }),
        cancellation,
        (lateStream) => cleanupCapture({ stream: lateStream }),
      );
      this.assertCaptureGeneration(generation);
      const negotiatedRate = negotiatedInput?.mimeType ? parsePcmRate(negotiatedInput.mimeType) : this.sampleRate;
      context = this.audioContextFactory({ sampleRate: negotiatedRate });
      if (context.state === "suspended") {
        await capturePrerequisite(context.resume(), cancellation);
      }
      this.assertCaptureGeneration(generation);
      await capturePrerequisite(context.audioWorklet.addModule(this.workletUrl), cancellation);
      this.assertCaptureGeneration(generation);
      source = context.createMediaStreamSource(stream);
      node = this.audioWorkletNodeFactory(context, "pcm-capture", {
        processorOptions: { frameMs: 50 },
      });
      const captureRate = Math.round(context.sampleRate);
      node.port.onmessage = (event) => {
        if (event.data?.type === "flushed") return;
        try {
          this.client.sendAudio(event.data, `audio/pcm;rate=${captureRate}`);
        } catch (error) {
          this.emitter.emit("error", { error: toError(error), code: "audio_send_failed" });
        }
      };
      source.connect(node);
      node.connect(context.destination);
      this.assertCaptureGeneration(generation);
      this.mediaStream = stream;
      this.captureContext = context;
      this.captureSource = source;
      this.workletNode = node;
      this.setMicrophoneState("active", { sampleRate: captureRate });
    } catch (error) {
      await cleanupCapture({ stream, context, source, node });
      if (generation === this.captureGeneration && !this.disposed) this.setMicrophoneState("idle");
      if (error?.name !== "AbortError") throw error;
    }
  }

  async stopMicrophone(options = {}) {
    if (this.microphoneStopPromise) return this.microphoneStopPromise;
    const stop = this.stopMicrophonePipeline(options);
    this.microphoneStopPromise = stop;
    try {
      await stop;
    } finally {
      if (this.microphoneStopPromise === stop) this.microphoneStopPromise = undefined;
    }
  }

  async stopMicrophonePipeline(options) {
    const endTurn = options.endTurn ?? true;
    const wasActive = this.microphoneState === "active";
    ++this.captureGeneration;
    if (this.microphoneState !== "disposed") this.setMicrophoneState("stopping");
    this.microphoneStartCancellation?.cancel();
    await this.microphoneStartPromise?.catch(() => undefined);
    if (wasActive) await this.flushMicrophone();
    if (endTurn && wasActive && this.client.connected) this.client.endAudio();

    const capture = {
      stream: this.mediaStream,
      context: this.captureContext,
      source: this.captureSource,
      node: this.workletNode,
    };
    this.mediaStream = undefined;
    this.captureContext = undefined;
    this.captureSource = undefined;
    this.workletNode = undefined;
    await cleanupCapture(capture);
    this.setMicrophoneState(this.disposed ? "disposed" : "idle");
  }

  async flushMicrophone() {
    const node = this.workletNode;
    if (!node) return;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, 150);
      const onMessage = (event) => {
        if (event.data?.type !== "flushed") return;
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        node.port.removeEventListener("message", onMessage);
      };
      node.port.addEventListener("message", onMessage);
      node.port.postMessage({ type: "flush" });
    });
  }

  play(message) {
    if (this.disposed || this.playbackSuppressed) return Promise.resolve(false);
    let frame;
    try {
      frame = preparePlaybackFrame(message, this.decodeBase64);
    } catch (error) {
      return Promise.reject(error);
    }

    const scheduledMs = this.playbackContext && this.playbackContext.state !== "closed"
      ? this.calculateQueuedPlaybackMs(this.playbackContext.currentTime)
      : 0;
    const queuedMs = scheduledMs + this.pendingPlaybackMs;
    const queuedFrames = this.playbackSources.size + this.pendingPlaybackFrames;
    if (
      queuedFrames >= this.maxQueuedAudioFrames ||
      queuedMs + frame.durationMs > this.maxQueuedAudioMs
    ) {
      this.emitter.emit("audio.dropped", {
        direction: "output",
        reason: "playback_backpressure",
        queuedMs,
        droppedMs: frame.durationMs,
      });
      return Promise.resolve(false);
    }

    const generation = this.playbackGeneration;
    const epoch = this.playbackEpoch;
    this.pendingPlaybackMs += frame.durationMs;
    this.pendingPlaybackFrames += 1;
    const operation = this.playbackChain.then(async () => {
      try {
        return await this.schedulePlayback(frame, generation, epoch);
      } finally {
        this.pendingPlaybackMs = Math.max(0, this.pendingPlaybackMs - frame.durationMs);
        this.pendingPlaybackFrames = Math.max(0, this.pendingPlaybackFrames - 1);
      }
    });
    this.playbackChain = operation.catch(() => undefined);
    return operation;
  }

  async schedulePlayback(frame, generation, epoch) {
    if (
      this.disposed ||
      this.playbackSuppressed ||
      generation !== this.playbackGeneration ||
      epoch !== this.playbackEpoch
    ) return false;

    const context = this.ensurePlaybackContext();
    if (context.state !== "running") {
      const resumed = await Promise.race([
        this.resumePlaybackContext(context).then(() => true),
        epoch.invalidated.then(() => false),
      ]);
      if (!resumed) return false;
    }
    if (
      this.disposed ||
      this.playbackSuppressed ||
      generation !== this.playbackGeneration ||
      epoch !== this.playbackEpoch
    ) return false;

    const queuedMs = this.calculateQueuedPlaybackMs(context.currentTime);
    if (queuedMs + frame.durationMs > this.maxQueuedAudioMs) {
      this.emitter.emit("audio.dropped", {
        direction: "output",
        reason: "playback_backpressure",
        queuedMs,
        droppedMs: frame.durationMs,
      });
      return false;
    }

    const buffer = context.createBuffer(1, frame.samples.length, frame.rate);
    buffer.copyToChannel(frame.samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, this.playbackCursor || 0);
    const contentIndex = frame.contentIndex;
    const itemKey = frame.itemId ? `${frame.itemId}:${contentIndex}` : "";
    if (itemKey && !this.playbackItems.has(itemKey)) {
      this.playbackItems.set(itemKey, { itemId: frame.itemId, contentIndex, playedMs: 0 });
      trimOldestMapEntries(this.playbackItems, 32);
    }
    const record = {
      source,
      context,
      itemKey,
      startAt,
      endAt: startAt + buffer.duration,
      duration: buffer.duration,
      stopped: false,
    };
    this.playbackSources.add(record);
    this.playbackCursor = record.endAt;
    source.addEventListener("ended", () => this.finishPlaybackRecord(record), { once: true });
    source.start(startAt);
    this.emitter.emit("playback", {
      active: true,
      queued: this.playbackSources.size,
      queuedMs: this.calculateQueuedPlaybackMs(context.currentTime),
    });
    return true;
  }

  finishPlaybackRecord(record) {
    if (!this.playbackSources.delete(record)) return;
    if (!record.stopped && record.itemKey) this.addPlayedAudio(record.itemKey, record.duration * 1_000);
    if (this.playbackSources.size === 0) this.playbackCursor = 0;
    this.emitter.emit("playback", {
      active: this.playbackSources.size > 0,
      queued: this.playbackSources.size,
      queuedMs: this.calculateQueuedPlaybackMs(record.context.currentTime),
    });
  }

  interrupt(reason = "user interrupted") {
    this.playbackSuppressed = true;
    const truncate = this.clearPlayback();
    if (this.client.connected) this.client.cancelResponse(reason, truncate);
    return truncate;
  }

  clearPlayback() {
    this.playbackEpoch.invalidate();
    this.playbackEpoch = createPlaybackEpoch();
    ++this.playbackGeneration;
    const records = [...this.playbackSources].sort((left, right) => left.startAt - right.startAt);
    const now = this.playbackContext?.currentTime ?? 0;
    const audible = records.find((record) => now >= record.startAt && now < record.endAt);
    const target = audible ?? records.find((record) => record.itemKey);

    for (const record of records) {
      if (record.itemKey) {
        const playedSeconds = Math.max(0, Math.min(record.duration, now - record.startAt));
        this.addPlayedAudio(record.itemKey, playedSeconds * 1_000);
      }
      record.stopped = true;
      try {
        record.source.stop();
      } catch {
        // A source may already have ended between snapshot and stop.
      }
    }
    this.playbackSources.clear();
    this.playbackCursor = 0;
    const targetItem = target?.itemKey ? this.playbackItems.get(target.itemKey) : undefined;
    this.playbackItems.clear();
    this.emitter.emit("playback", { active: false, queued: 0, queuedMs: 0 });
    return targetItem
      ? {
          itemId: targetItem.itemId,
          contentIndex: targetItem.contentIndex,
          audioEndMs: Math.max(0, Math.floor(targetItem.playedMs)),
        }
      : undefined;
  }

  calculateQueuedPlaybackMs(now) {
    let queuedMs = 0;
    for (const record of this.playbackSources) {
      queuedMs += Math.max(0, record.endAt - Math.max(now, record.startAt)) * 1_000;
    }
    return queuedMs;
  }

  addPlayedAudio(itemKey, playedMs) {
    const item = this.playbackItems.get(itemKey);
    if (item) item.playedMs += Math.max(0, playedMs);
  }

  ensurePlaybackContext() {
    if (!this.playbackContext || this.playbackContext.state === "closed") {
      this.playbackContext = this.audioContextFactory({});
      this.playbackCursor = 0;
    }
    return this.playbackContext;
  }

  resumePlaybackContext(context) {
    if (context.state === "running") return Promise.resolve();
    if (context.state === "closed") {
      return Promise.reject(new Error("Browser audio playback context is closed."));
    }
    if (this.playbackResumeContext === context && this.playbackResumePromise) {
      return this.playbackResumePromise;
    }

    let cancel;
    const operation = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(
        () => finish(new Error(
          "Browser audio playback did not start in time. Allow audio, then retry from a user gesture.",
        )),
        this.playbackResumeTimeoutMs,
      );
      cancel = () => finish(abortError());
      try {
        Promise.resolve(context.resume()).then(() => finish(), (error) => finish(toError(error)));
      } catch (error) {
        finish(toError(error));
      }
    }).finally(() => {
      if (this.playbackResumePromise === operation) {
        this.playbackResumeContext = undefined;
        this.playbackResumePromise = undefined;
        this.cancelPlaybackResume = undefined;
      }
    });
    this.playbackResumeContext = context;
    this.playbackResumePromise = operation;
    this.cancelPlaybackResume = cancel;
    return operation;
  }

  async closePlaybackContext() {
    this.clearPlayback();
    this.cancelPlaybackResume?.();
    const context = this.playbackContext;
    this.playbackContext = undefined;
    if (context && context.state !== "closed") {
      await playbackDeadline(
        Promise.resolve().then(() => context.close()),
        this.playbackResumeTimeoutMs,
        "Browser audio playback context did not close in time.",
      ).catch(() => undefined);
    }
  }

  assertCaptureGeneration(generation) {
    if (this.disposed || generation !== this.captureGeneration) throw abortError();
  }

  setMicrophoneState(state, detail = {}) {
    if (this.microphoneState === state && Object.keys(detail).length === 0) return;
    this.microphoneState = state;
    this.emitter.emit("microphone", { state, active: state === "active", ...detail });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.stopMicrophone({ endTurn: false });
    this.clearPlayback();
    await this.closePlaybackContext();
    this.unsubscribeClose?.();
    this.unsubscribeResponseStarted?.();
    this.unsubscribeResponseCancelled?.();
    this.unsubscribeResponseFailed?.();
    this.emitter.clear();
  }
}

export function normalizeGatewayWebSocketUrl(value) {
  return normalizeWebSocketUrl(value, { allowTokenQuery: false });
}

function normalizeWebSocketUrl(value, { allowTokenQuery }) {
  const url = new URL(String(value));
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("Hermes Live gateway URL must use ws:// or wss://.");
  }
  if (url.username || url.password) {
    throw new TypeError("Do not place credentials in the Hermes Live gateway URL.");
  }
  if (!allowTokenQuery && url.searchParams.has("token")) {
    throw new TypeError("Pass the Hermes Live token separately so it is not retained in the configured URL.");
  }
  url.hash = "";
  return url.toString();
}

export function buildGatewayWebSocketUrl(baseUrl, token) {
  const url = new URL(normalizeGatewayWebSocketUrl(baseUrl));
  const normalizedToken = String(token ?? "").trim();
  if (normalizedToken) url.searchParams.set("token", normalizedToken);
  return url;
}

export function arrayBufferToBase64(value) {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : undefined;
  if (!bytes) throw new TypeError("Audio input must be an ArrayBuffer, typed array, or base64 string.");
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function validateServerMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
    throw new TypeError("Hermes Live returned a message without a type.");
  }
  const message = value;
  switch (message.type) {
    case "session.ready": {
      requireOnlyKeys(message, ["type", "protocolVersion", "requestId", "sessionId", "model", "hermes", "realtime", "tasks", "conversation"]);
      requireInteger(message, "protocolVersion", { positive: true, maximum: 1_000 });
      if (message.protocolVersion !== HERMES_LIVE_PROTOCOL_VERSION) {
        throw new TypeError(
          `Hermes Live protocol version ${message.protocolVersion} is not supported by this protocol v4 client. Upgrade the gateway and client together.`,
        );
      }
      optionalOpaqueId(message, "requestId", 128);
      requireOpaqueId(message, "sessionId");
      requireBoundedString(message, "model", PUBLIC_MODEL_MAX_CHARS);
      requireObject(message, "hermes");
      requireOnlyKeys(message.hermes, ["model", "capabilities"], "session.ready hermes");
      optionalBoundedStringField(
        message.hermes,
        "model",
        PUBLIC_MODEL_MAX_CHARS,
        { label: "session.ready hermes" },
      );
      if (message.hermes.capabilities !== undefined) {
        validateBoundedJsonObject(message.hermes.capabilities, "session.ready hermes capabilities");
      }
      requireObject(message, "realtime");
      validateRealtimeCapabilities(message.realtime);
      requireObject(message, "tasks");
      validateTaskCapabilities(message.tasks);
      requireObject(message, "conversation");
      validatePublicConversation(message.conversation);
      break;
    }
    case "session.error":
      requireOnlyKeys(message, ["type", "code", "message", "requestId", "recoverable"]);
      requireBoundedString(message, "code", PUBLIC_ERROR_CODE_MAX_CHARS);
      requireBoundedString(message, "message", PUBLIC_TASK_ERROR_MAX_CHARS);
      optionalOpaqueId(message, "requestId", 128);
      optionalBoolean(message, "recoverable");
      break;
    case "audio.output":
      requireOnlyKeys(message, ["type", "data", "mimeType", "itemId", "contentIndex"]);
      requireBoundedString(message, "data", PUBLIC_AUDIO_BASE64_MAX_CHARS);
      requireBoundedString(message, "mimeType", PUBLIC_MIME_TYPE_MAX_CHARS);
      optionalOpaqueId(message, "itemId");
      optionalInteger(message, "contentIndex", { maximum: 100 });
      break;
    case "transcript.delta":
      requireOnlyKeys(message, ["type", "speaker", "text", "final"]);
      requireEnum(message, "speaker", ["user", "assistant", "system"]);
      requireBoundedString(message, "text", PUBLIC_TRANSCRIPT_MAX_CHARS);
      optionalBoolean(message, "final");
      break;
    case "input.speech_started":
      requireOnlyKeys(message, ["type", "provider", "itemId", "audioStartMs"]);
      requireEnum(message, "provider", ["openai"]);
      optionalOpaqueId(message, "itemId");
      optionalFiniteNumber(message, "audioStartMs", { minimum: 0, maximum: 3_600_000 });
      break;
    case "response.started":
    case "response.completed":
    case "response.cancelled":
      requireOnlyKeys(message, ["type", "responseId"]);
      optionalOpaqueId(message, "responseId");
      break;
    case "response.failed":
      requireOnlyKeys(message, ["type", "responseId", "error"]);
      optionalOpaqueId(message, "responseId");
      requireBoundedString(message, "error", PUBLIC_TASK_ERROR_MAX_CHARS);
      break;
    case "task.snapshot": {
      requireOnlyKeys(message, ["type", "reason", "requestId", "tasks", "truncated"]);
      requireEnum(message, "reason", ["initial", "reconnect", "list", "get"]);
      optionalOpaqueId(message, "requestId", 128);
      if ((message.reason === "list" || message.reason === "get") && !message.requestId) {
        throw new TypeError(`Hermes Live task.snapshot ${message.reason} requires requestId.`);
      }
      if (!Array.isArray(message.tasks) || message.tasks.length > MAX_TASK_LIST_LIMIT) {
        throw new TypeError("Hermes Live task.snapshot requires at most 100 tasks.");
      }
      if (message.reason === "get" && message.tasks.length > 1) {
        throw new TypeError("Hermes Live task.snapshot get can contain at most one task.");
      }
      const seenTaskIds = new Set();
      message.tasks = message.tasks.map((task) => {
        const normalized = validateTaskSnapshot(task);
        if (seenTaskIds.has(normalized.taskId)) {
          throw new TypeError(`Hermes Live task.snapshot repeated task ${normalized.taskId}.`);
        }
        seenTaskIds.add(normalized.taskId);
        return normalized;
      });
      requireBoolean(message, "truncated");
      break;
    }
    case "task.accepted":
      requireOnlyKeys(message, ["type", "sequence", "taskId", "occurredAt", "requestId", "state", "title", "kind", "parentTaskId", "rootTaskId"]);
      validateTaskEventBase(message);
      optionalOpaqueId(message, "requestId", 128);
      requireEnum(message, "state", ["accepted", "queued"]);
      optionalBoundedStringField(message, "title", PUBLIC_TASK_TITLE_MAX_CHARS);
      optionalTaskLineage(message);
      break;
    case "task.started":
      requireOnlyKeys(message, ["type", "sequence", "taskId", "occurredAt", "title"]);
      validateTaskEventBase(message);
      optionalBoundedStringField(message, "title", PUBLIC_TASK_TITLE_MAX_CHARS);
      break;
    case "task.progress":
      requireOnlyKeys(message, ["type", "sequence", "taskId", "occurredAt", "progress"]);
      validateTaskEventBase(message);
      requireObject(message, "progress");
      message.progress = validateTaskProgress(message.progress);
      break;
    case "task.stopping":
      requireOnlyKeys(message, ["type", "sequence", "taskId", "occurredAt", "requestId", "reason"]);
      validateTaskEventBase(message);
      optionalOpaqueId(message, "requestId", 128);
      optionalBoundedStringField(message, "reason", PUBLIC_TASK_REASON_MAX_CHARS, { allowEmpty: true });
      break;
    case "task.completed":
      requireOnlyKeys(message, ["type", "sequence", "taskId", "occurredAt", "requestId", "result"]);
      validateTaskEventBase(message);
      optionalOpaqueId(message, "requestId", 128);
      requireObject(message, "result");
      message.result = validateTaskResult(message.result);
      break;
    case "task.failed":
      requireOnlyKeys(message, ["type", "sequence", "taskId", "occurredAt", "requestId", "error"]);
      validateTaskEventBase(message);
      optionalOpaqueId(message, "requestId", 128);
      requireObject(message, "error");
      message.error = validateTaskError(message.error);
      break;
    case "task.cancelled":
      requireOnlyKeys(message, ["type", "sequence", "taskId", "occurredAt", "requestId", "reason"]);
      validateTaskEventBase(message);
      optionalOpaqueId(message, "requestId", 128);
      optionalBoundedStringField(message, "reason", PUBLIC_TASK_REASON_MAX_CHARS, { allowEmpty: true });
      break;
    case "task.unknown":
      requireOnlyKeys(message, ["type", "sequence", "taskId", "occurredAt", "requestId", "error"]);
      validateTaskEventBase(message);
      optionalOpaqueId(message, "requestId", 128);
      requireObject(message, "error");
      message.error = validateTaskError(message.error);
      break;
    case "task.notification":
      requireOnlyKeys(message, ["type", "sequence", "taskId", "occurredAt", "requestId", "notification"]);
      validateTaskEventBase(message);
      optionalOpaqueId(message, "requestId", 128);
      requireObject(message, "notification");
      message.notification = validateTaskNotification(message.notification);
      break;
    case "log":
      requireOnlyKeys(message, ["type", "level", "message", "data"]);
      requireEnum(message, "level", ["debug", "info", "warn", "error"]);
      requireBoundedString(message, "message", PUBLIC_LOG_MAX_CHARS);
      if (message.data !== undefined) validateBoundedJsonObject(message.data, "log data");
      break;
    default:
      if (message.type.startsWith("run.")) {
        throw new TypeError(
          `Hermes Live received legacy protocol v2 message ${message.type}; this protocol v4 client accepts task.* lifecycle messages only.`,
        );
      }
  }
  return message;
}

function requireString(value, key, allowEmpty = false) {
  if (typeof value[key] !== "string" || (!allowEmpty && value[key].length === 0)) {
    throw new TypeError(`Hermes Live ${value.type} message requires ${key}.`);
  }
}

function requireBoundedString(value, key, maximum, options = {}) {
  const string = value[key];
  if (
    typeof string !== "string" ||
    (!options.allowEmpty && string.length === 0) ||
    string.length > maximum
  ) {
    throw new TypeError(
      `Hermes Live ${options.label ?? value.type} requires ${key} with at most ${maximum} characters.`,
    );
  }
}

function optionalBoundedStringField(value, key, maximum, options = {}) {
  if (value[key] === undefined) return;
  requireBoundedString(value, key, maximum, options);
}

function requireEnum(value, key, allowed) {
  requireString(value, key);
  if (!allowed.includes(value[key])) {
    throw new TypeError(`Hermes Live ${value.type} message contains an unsupported ${key}.`);
  }
}

function requireObject(value, key) {
  if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key])) {
    throw new TypeError(`Hermes Live ${value.type} message requires ${key}.`);
  }
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Hermes Live ${label} must be an object.`);
  }
}

function validateBoundedJsonObject(value, label) {
  // Parsed WebSocket JSON contains ordinary data objects. JavaScript offers no
  // trap-free way to inspect a caller-supplied Proxy; any trap exception is
  // therefore treated as validation failure. Accessor properties are rejected
  // without invocation below so direct callers cannot smuggle executable reads
  // into otherwise JSON-shaped metadata.
  requirePlainObject(value, label);
  const stack = [{ value, depth: 1, exit: false }];
  const ancestors = new WeakSet();
  let serializedChars = 0;
  let keyCount = 0;
  let nodeCount = 0;

  const addSerializedChars = (count) => {
    serializedChars += count;
    if (serializedChars > PUBLIC_JSON_MAX_CHARS) {
      throw new TypeError(`Hermes Live ${label} exceeds ${PUBLIC_JSON_MAX_CHARS} serialized characters.`);
    }
  };

  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry.exit) {
      ancestors.delete(entry.value);
      continue;
    }
    nodeCount += 1;
    if (nodeCount > PUBLIC_JSON_MAX_NODES || entry.depth > PUBLIC_JSON_MAX_DEPTH) {
      throw new TypeError(`Hermes Live ${label} exceeds its safe JSON structure limit.`);
    }

    const current = entry.value;
    if (current === null) {
      addSerializedChars(4);
      continue;
    }
    switch (typeof current) {
      case "string":
        addSerializedChars(JSON.stringify(current).length);
        continue;
      case "number": {
        if (!Number.isFinite(current)) {
          throw new TypeError(`Hermes Live ${label} contains a non-finite JSON number.`);
        }
        addSerializedChars(JSON.stringify(current).length);
        continue;
      }
      case "boolean":
        addSerializedChars(current ? 4 : 5);
        continue;
      case "object":
        break;
      default:
        throw new TypeError(`Hermes Live ${label} contains a non-JSON value.`);
    }

    const array = Array.isArray(current);
    if (!array && !isPlainJsonObject(current)) {
      throw new TypeError(`Hermes Live ${label} contains a non-plain JSON object.`);
    }
    if (ancestors.has(current)) {
      throw new TypeError(`Hermes Live ${label} contains a circular JSON value.`);
    }
    ancestors.add(current);
    stack.push({ value: current, depth: entry.depth, exit: true });

    if (array) {
      addSerializedChars(2 + Math.max(0, current.length - 1));
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor) {
          throw new TypeError(`Hermes Live ${label} contains a sparse JSON array.`);
        }
        if (!("value" in descriptor)) {
          throw new TypeError(`Hermes Live ${label} contains an accessor instead of JSON data.`);
        }
        stack.push({ value: descriptor.value, depth: entry.depth + 1, exit: false });
      }
      continue;
    }

    const keys = Object.keys(current);
    keyCount += keys.length;
    if (keyCount > PUBLIC_JSON_MAX_KEYS) {
      throw new TypeError(`Hermes Live ${label} exceeds its safe JSON key limit.`);
    }
    addSerializedChars(2 + Math.max(0, keys.length - 1));
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(`Hermes Live ${label} contains an accessor instead of JSON data.`);
      }
      addSerializedChars(JSON.stringify(key).length + 1);
      stack.push({ value: descriptor.value, depth: entry.depth + 1, exit: false });
    }
  }

  return value;
}

function isPlainJsonObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireOnlyKeys(value, keys, label = value.type) {
  const allowed = new Set(keys);
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported) throw new TypeError(`Hermes Live ${label} contains unsupported field ${unsupported}.`);
}

function requireOpaqueId(value, key, maximum = 256) {
  requireString(value, key);
  if (value[key].length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value[key])) {
    throw new TypeError(`Hermes Live ${value.type} message contains an unsafe ${key}.`);
  }
}

function optionalOpaqueId(value, key, maximum = 256) {
  if (value[key] !== undefined) requireOpaqueId(value, key, maximum);
}

function requireBoolean(value, key) {
  if (typeof value[key] !== "boolean") {
    throw new TypeError(`Hermes Live ${value.type} message requires boolean ${key}.`);
  }
}

function optionalBoolean(value, key) {
  if (value[key] !== undefined) requireBoolean(value, key);
}

function requireInteger(value, key, options = {}) {
  const number = value[key];
  if (
    !Number.isSafeInteger(number) ||
    (options.positive ? number < 1 : number < (options.minimum ?? 0)) ||
    number > (options.maximum ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw new TypeError(`Hermes Live ${value.type} message contains an invalid ${key}.`);
  }
}

function optionalInteger(value, key, options = {}) {
  if (value[key] !== undefined) requireInteger(value, key, options);
}

function optionalFiniteNumber(value, key, options = {}) {
  if (value[key] === undefined) return;
  const number = value[key];
  if (
    typeof number !== "number" ||
    !Number.isFinite(number) ||
    number < (options.minimum ?? -Infinity) ||
    number > (options.maximum ?? Infinity)
  ) {
    throw new TypeError(`Hermes Live ${value.type} message contains an invalid ${key}.`);
  }
}

function validateTaskCapabilities(value) {
  requireOnlyKeys(value, ["scope", "sequence", "reconnect", "durable", "parallel", "maxConcurrent", "maxRetained", "supports"], "session.ready tasks");
  const typed = { ...value, type: "session.ready tasks" };
  requireEnum(typed, "scope", ["owner"]);
  requireEnum(typed, "sequence", ["per_task"]);
  requireEnum(typed, "reconnect", ["snapshot"]);
  requireBoolean(typed, "durable");
  requireBoolean(typed, "parallel");
  requireInteger(typed, "maxConcurrent", { positive: true, maximum: 64 });
  requireInteger(typed, "maxRetained", { positive: true, maximum: 10_000 });
  requireObject(typed, "supports");
  requireOnlyKeys(value.supports, ["list", "get", "stop", "followUp", "resume", "notificationAck"], "session.ready task supports");
  const supports = { ...value.supports, type: "session.ready task supports" };
  for (const key of ["list", "get", "stop", "followUp", "notificationAck"]) requireBoolean(supports, key);
  if (supports.resume !== false) {
    throw new TypeError("Hermes Live session.ready task supports must declare resume as false.");
  }
}

function validatePublicConversation(value) {
  requireOnlyKeys(value, ["mode", "sessionId", "title", "source", "preview", "lastActiveAt"], "session.ready conversation");
  const typed = { ...value, type: "session.ready conversation" };
  requireEnum(typed, "mode", ["new", "resume", "unbound"]);
  optionalOpaqueId(typed, "sessionId");
  optionalBoundedStringField(typed, "title", PUBLIC_CONVERSATION_TITLE_MAX_CHARS);
  optionalBoundedStringField(typed, "source", 64);
  optionalBoundedStringField(typed, "preview", PUBLIC_CONVERSATION_PREVIEW_MAX_CHARS, { allowEmpty: true });
  optionalInteger(typed, "lastActiveAt");
  if (typed.mode === "unbound" && typed.sessionId !== undefined) {
    throw new TypeError("Hermes Live session.ready conversation cannot bind an unbound session.");
  }
  if (typed.mode !== "unbound" && typed.sessionId === undefined) {
    throw new TypeError("Hermes Live session.ready conversation is missing its Hermes sessionId.");
  }
}

function validateTaskEventBase(message) {
  requireOpaqueId(message, "taskId");
  requireInteger(message, "sequence", { positive: true });
  requireInteger(message, "occurredAt");
}

function validateTaskSnapshot(value) {
  requirePlainObject(value, "task snapshot");
  requireOnlyKeys(value, [
    "taskId",
    "kind",
    "parentTaskId",
    "rootTaskId",
    "sequence",
    "state",
    "title",
    "createdAt",
    "updatedAt",
    "startedAt",
    "finishedAt",
    "progress",
    "result",
    "error",
  ], "task snapshot");
  const typed = { ...value, type: "task snapshot" };
  requireOpaqueId(typed, "taskId");
  optionalTaskLineage(typed);
  requireInteger(typed, "sequence", { positive: true });
  requireEnum(typed, "state", [
    "accepted",
    "queued",
    "running",
    "stopping",
    "completed",
    "failed",
    "cancelled",
    "unknown",
  ]);
  optionalBoundedStringField(typed, "title", PUBLIC_TASK_TITLE_MAX_CHARS);
  requireInteger(typed, "createdAt");
  requireInteger(typed, "updatedAt");
  optionalInteger(typed, "startedAt");
  optionalInteger(typed, "finishedAt");
  const normalized = { ...value };
  if (value.progress !== undefined) normalized.progress = validateTaskProgress(value.progress);
  if (value.result !== undefined) normalized.result = validateTaskResult(value.result);
  if (value.error !== undefined) normalized.error = validateTaskError(value.error);
  if (value.state === "completed" && !normalized.result) {
    throw new TypeError("Hermes Live completed task snapshot requires a result.");
  }
  if (["failed", "unknown"].includes(value.state) && !normalized.error) {
    throw new TypeError(`Hermes Live ${value.state} task snapshot requires an error.`);
  }
  return freezeTaskSnapshot(normalized);
}

function optionalTaskLineage(value) {
  if (value.kind !== undefined) requireEnum(value, "kind", ["background", "follow_up"]);
  optionalOpaqueId(value, "parentTaskId");
  optionalOpaqueId(value, "rootTaskId");
  if (value.kind === "follow_up" && (!value.parentTaskId || !value.rootTaskId)) {
    throw new TypeError("Hermes Live follow-up task is missing its lineage.");
  }
}

function validateTaskProgress(value) {
  requirePlainObject(value, "task progress");
  requireOnlyKeys(value, ["message", "stage", "current", "total", "percent"], "task progress");
  const typed = { ...value, type: "task progress" };
  requireBoundedString(typed, "message", PUBLIC_TASK_PROGRESS_MAX_CHARS);
  optionalBoundedStringField(typed, "stage", PUBLIC_TASK_STAGE_MAX_CHARS);
  optionalInteger(typed, "current");
  optionalInteger(typed, "total", { positive: true });
  optionalFiniteNumber(typed, "percent", { minimum: 0, maximum: 100 });
  if (typed.current !== undefined && typed.total !== undefined && typed.current > typed.total) {
    throw new TypeError("Hermes Live task progress current cannot exceed total.");
  }
  return Object.freeze({ ...value });
}

function validateTaskResult(value) {
  requirePlainObject(value, "task result");
  requireOnlyKeys(value, ["summary", "output", "truncated", "usage"], "task result");
  const typed = { ...value, type: "task result" };
  optionalBoundedStringField(typed, "summary", PUBLIC_TASK_SUMMARY_MAX_CHARS);
  optionalBoundedStringField(typed, "output", PUBLIC_TASK_OUTPUT_MAX_CHARS, { allowEmpty: true });
  if (typed.summary === undefined && typed.output === undefined) {
    throw new TypeError("Hermes Live task result requires a summary or output.");
  }
  requireBoolean(typed, "truncated");
  if (typed.usage !== undefined) validateBoundedJsonObject(typed.usage, "task result usage");
  return Object.freeze({
    ...value,
    ...(value.usage === undefined ? {} : { usage: Object.freeze({ ...value.usage }) }),
  });
}

function validateTaskError(value) {
  requirePlainObject(value, "task error");
  requireOnlyKeys(value, ["code", "message", "recoverable"], "task error");
  const typed = { ...value, type: "task error" };
  requireBoundedString(typed, "code", PUBLIC_ERROR_CODE_MAX_CHARS);
  requireBoundedString(typed, "message", PUBLIC_TASK_ERROR_MAX_CHARS);
  requireBoolean(typed, "recoverable");
  return Object.freeze({ ...value });
}

function validateTaskNotification(value) {
  requirePlainObject(value, "task notification");
  requireOnlyKeys(value, ["notificationId", "kind", "delivery", "message", "createdAt", "acknowledged"], "task notification");
  const typed = { ...value, type: "task notification" };
  requireOpaqueId(typed, "notificationId");
  requireEnum(typed, "kind", ["completed", "failed", "cancelled", "unknown"]);
  requireEnum(typed, "delivery", ["interrupt", "when_idle", "silent"]);
  requireBoundedString(typed, "message", PUBLIC_NOTIFICATION_MAX_CHARS);
  requireInteger(typed, "createdAt");
  requireBoolean(typed, "acknowledged");
  return Object.freeze({ ...value });
}

function validateRealtimeCapabilities(value) {
  requireOnlyKeys(value, ["provider", "model", "audio"], "session.ready realtime");
  const realtime = { ...value, type: "session.ready realtime" };
  requireEnum(realtime, "provider", ["gemini", "openai", "mock"]);
  requireBoundedString(realtime, "model", PUBLIC_MODEL_MAX_CHARS);
  requireObject(realtime, "audio");
  const audio = value.audio;
  requireOnlyKeys(audio, ["input", "output", "turnDetection"], "session.ready realtime audio");
  const typedAudio = { ...audio, type: "session.ready realtime audio" };
  requireObject(typedAudio, "input");
  requireObject(typedAudio, "output");
  requireEnum(
    typedAudio,
    "turnDetection",
    ["disabled", "semantic_vad", "server_vad", "provider", "none"],
  );
  requireOnlyKeys(audio.input, ["enabled", "mimeType", "recommendedFrameMs"], "session.ready realtime audio input");
  requireOnlyKeys(audio.output, ["enabled", "mimeType"], "session.ready realtime audio output");
  const input = { ...audio.input, type: "session.ready realtime audio input" };
  const output = { ...audio.output, type: "session.ready realtime audio output" };
  requireBoolean(input, "enabled");
  requireBoolean(output, "enabled");
  optionalBoundedStringField(input, "mimeType", PUBLIC_MIME_TYPE_MAX_CHARS);
  optionalBoundedStringField(output, "mimeType", PUBLIC_MIME_TYPE_MAX_CHARS);
  optionalInteger(input, "recommendedFrameMs", { positive: true, maximum: 1_000 });
  if (input.enabled && !input.mimeType) requireString(input, "mimeType");
  if (output.enabled && !output.mimeType) requireString(output, "mimeType");
}

function createSnapshot(connection) {
  const empty = Object.freeze([]);
  return Object.freeze({
    connection,
    session: undefined,
    tasks: empty,
    activeTasks: empty,
    recentTasks: empty,
    unreadNotifications: empty,
    lastError: undefined,
  });
}

function taskFromLifecycle(existing, message) {
  switch (message.type) {
    case "task.accepted":
      return freezeTaskSnapshot({
        ...(existing ?? {}),
        taskId: message.taskId,
        sequence: Math.max(existing?.sequence ?? 0, message.sequence),
        state: message.state,
        ...(message.title === undefined ? {} : { title: message.title }),
        ...(message.kind === undefined ? {} : { kind: message.kind }),
        ...(message.parentTaskId === undefined ? {} : { parentTaskId: message.parentTaskId }),
        ...(message.rootTaskId === undefined ? {} : { rootTaskId: message.rootTaskId }),
        createdAt: existing?.createdAt ?? message.occurredAt,
        updatedAt: Math.max(existing?.updatedAt ?? 0, message.occurredAt),
      });
    case "task.started":
      return nextTaskSnapshot(existing, message, {
        state: "running",
        startedAt: existing.startedAt ?? message.occurredAt,
        ...(message.title === undefined ? {} : { title: message.title }),
      }, ["error"]);
    case "task.progress":
      return nextTaskSnapshot(existing, message, {
        state: existing.state === "stopping" ? "stopping" : "running",
        progress: message.progress,
      }, ["error"]);
    case "task.stopping":
      return nextTaskSnapshot(existing, message, { state: "stopping" });
    case "task.completed":
      return nextTaskSnapshot(existing, message, {
        state: "completed",
        finishedAt: message.occurredAt,
        result: message.result,
      }, ["error"]);
    case "task.failed":
      return nextTaskSnapshot(existing, message, {
        state: "failed",
        finishedAt: message.occurredAt,
        error: message.error,
      }, ["result"]);
    case "task.cancelled":
      return nextTaskSnapshot(existing, message, {
        state: "cancelled",
        finishedAt: message.occurredAt,
      }, ["result", "error"]);
    case "task.unknown":
      return nextTaskSnapshot(existing, message, {
        state: "unknown",
        error: message.error,
      }, ["result"]);
    default:
      throw new Error(`Hermes Live cannot project ${message.type} as task lifecycle state.`);
  }
}

function nextTaskSnapshot(existing, message, patch, cleared = []) {
  const next = {
    ...existing,
    ...patch,
    taskId: message.taskId,
    sequence: Math.max(existing.sequence, message.sequence),
    updatedAt: Math.max(existing.updatedAt, message.occurredAt),
  };
  for (const key of cleared) delete next[key];
  return freezeTaskSnapshot(next);
}

function assertCompatibleTaskRevision(retained, incoming) {
  const conflict = (field) => {
    throw new Error(
      `Hermes Live received conflicting ${field} for ${incoming.taskId} at sequence ${incoming.sequence}.`,
    );
  };
  if (retained.taskId !== incoming.taskId) conflict("task id");
  if (retained.createdAt !== incoming.createdAt) conflict("task creation time");
  if (retained.state !== incoming.state) conflict("task state");
  if (retained.sequence === incoming.sequence && retained.updatedAt !== incoming.updatedAt) {
    conflict("task update time");
  }
  assertCompatibleOptional(retained.title, incoming.title, "task title", conflict);
  assertCompatibleOptional(retained.kind, incoming.kind, "task kind", conflict);
  assertCompatibleOptional(retained.parentTaskId, incoming.parentTaskId, "task parent", conflict);
  assertCompatibleOptional(retained.rootTaskId, incoming.rootTaskId, "task root", conflict);
  assertCompatibleOptional(retained.startedAt, incoming.startedAt, "task start time", conflict);
  assertCompatibleOptional(retained.finishedAt, incoming.finishedAt, "task finish time", conflict);
  assertCompatibleOptional(retained.progress, incoming.progress, "task progress", conflict);

  if (retained.result && incoming.result) {
    assertCompatibleOptional(retained.result.summary, incoming.result.summary, "task result summary", conflict);
    assertCompatibleOptional(retained.result.output, incoming.result.output, "task result output", conflict);
    assertCompatibleOptional(retained.result.usage, incoming.result.usage, "task result usage", conflict);
  } else if (Boolean(retained.result) !== Boolean(incoming.result) && incoming.state === "completed") {
    conflict("task result");
  }

  if (retained.error && incoming.error) {
    if (!sameStructuredValue(retained.error, incoming.error)) conflict("task error");
  } else if (
    Boolean(retained.error) !== Boolean(incoming.error) &&
    (incoming.state === "failed" || incoming.state === "unknown")
  ) {
    conflict("task error");
  }
}

function assertCompatibleOptional(retained, incoming, field, conflict) {
  if (retained !== undefined && incoming !== undefined && !sameStructuredValue(retained, incoming)) {
    conflict(field);
  }
}

function mergeEqualSequenceTask(retained, incoming) {
  const next = {
    ...retained,
    sequence: Math.max(retained.sequence, incoming.sequence),
    updatedAt: Math.max(retained.updatedAt, incoming.updatedAt),
  };
  if (next.title === undefined && incoming.title !== undefined) next.title = incoming.title;
  if (next.kind === undefined && incoming.kind !== undefined) next.kind = incoming.kind;
  if (next.parentTaskId === undefined && incoming.parentTaskId !== undefined) next.parentTaskId = incoming.parentTaskId;
  if (next.rootTaskId === undefined && incoming.rootTaskId !== undefined) next.rootTaskId = incoming.rootTaskId;
  if (next.startedAt === undefined && incoming.startedAt !== undefined) next.startedAt = incoming.startedAt;
  if (next.finishedAt === undefined && incoming.finishedAt !== undefined) next.finishedAt = incoming.finishedAt;
  if (next.progress === undefined && incoming.progress !== undefined) next.progress = incoming.progress;
  if (incoming.result) {
    if (!next.result) {
      next.result = incoming.result;
    } else {
      const result = { ...next.result };
      if (result.summary === undefined && incoming.result.summary !== undefined) {
        result.summary = incoming.result.summary;
      }
      if (result.output === undefined && incoming.result.output !== undefined) {
        result.output = incoming.result.output;
        result.truncated = incoming.result.truncated;
      }
      if (result.usage === undefined && incoming.result.usage !== undefined) {
        result.usage = incoming.result.usage;
      }
      next.result = result;
    }
  }
  if (!next.error && incoming.error) next.error = incoming.error;
  return freezeTaskSnapshot(next);
}

function mergeNewerLifecycleSnapshot(retained, incoming) {
  const next = {
    ...incoming,
    sequence: Math.max(retained.sequence, incoming.sequence),
    updatedAt: Math.max(retained.updatedAt, incoming.updatedAt),
  };
  if (
    retained.state === incoming.state &&
    retained.result?.output !== undefined &&
    next.result !== undefined &&
    next.result.output === undefined
  ) {
    next.result = {
      ...next.result,
      output: retained.result.output,
      truncated: retained.result.truncated,
    };
  }
  return freezeTaskSnapshot(next);
}

function taskEventFingerprint(message) {
  const { requestId: _requestId, ...content } = message;
  return compactStableFingerprint(content);
}

function sameStructuredValue(left, right) {
  return stableCanonicalValue(left) === stableCanonicalValue(right);
}

function compactStableFingerprint(value) {
  const canonical = stableCanonicalValue(value);
  // Retain a fixed-size replay discriminator instead of a second copy of a
  // lifecycle payload: one completed event can carry 200k output characters
  // and the client keeps revisions for as many as 2,048 task shells. Four
  // independent 32-bit lanes plus canonical length and edge samples make an
  // accidental collision negligible while keeping the bounded ledger below
  // roughly 1 MiB. Authentication remains the WebSocket/session boundary;
  // this fingerprint detects contradictory replays, it is not an auth token.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let third = 0x85ebca6b;
  let fourth = 0xc2b2ae35;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x5bd1e995) >>> 0;
    third = Math.imul(third + code, 0x27d4eb2d) >>> 0;
    fourth = (Math.imul(fourth, 33) ^ code) >>> 0;
  }
  const digest = [canonical.length, first, second, third, fourth]
    .map((part) => part.toString(36))
    .join(":");
  return `${digest}:${JSON.stringify(canonical.slice(0, 64))}:${JSON.stringify(canonical.slice(-64))}`;
}

function stableCanonicalValue(value) {
  const output = [];
  const stack = [{ kind: "value", value }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry.kind === "text") {
      output.push(entry.value);
      continue;
    }
    const current = entry.value;
    if (current === undefined) {
      output.push("undefined");
    } else if (current === null || typeof current !== "object") {
      output.push(JSON.stringify(current));
    } else if (Array.isArray(current)) {
      output.push("[");
      stack.push({ kind: "text", value: "]" });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (index < current.length - 1) stack.push({ kind: "text", value: "," });
        stack.push({ kind: "value", value: current[index] });
      }
    } else {
      output.push("{");
      stack.push({ kind: "text", value: "}" });
      const keys = Object.keys(current).sort();
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        if (index < keys.length - 1) stack.push({ kind: "text", value: "," });
        const key = keys[index];
        stack.push({ kind: "value", value: current[key] });
        stack.push({ kind: "text", value: ":" });
        stack.push({ kind: "text", value: JSON.stringify(key) });
      }
    }
  }
  return output.join("");
}

function freezeTaskSnapshot(value) {
  const task = { ...value };
  if (task.progress) task.progress = Object.freeze({ ...task.progress });
  if (task.result) {
    task.result = Object.freeze({
      ...task.result,
      ...(task.result.usage ? { usage: Object.freeze({ ...task.result.usage }) } : {}),
    });
  }
  if (task.error) task.error = Object.freeze({ ...task.error });
  return Object.freeze(task);
}

function compareTaskNewestFirst(left, right) {
  return right.updatedAt - left.updatedAt || left.taskId.localeCompare(right.taskId);
}

function compareTaskOldestFirst(left, right) {
  return left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId);
}

function notificationKey(taskId, notificationId) {
  return JSON.stringify([taskId, notificationId]);
}

function requireClientId(value, label, maximum = 256) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new TypeError(`Hermes Live requires a safe ${label}.`);
  }
  return value;
}

function optionalBoundedString(value, maximum, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new TypeError(`Hermes Live ${label} must be a string of at most ${maximum} characters.`);
  }
  return value;
}

function normalizeConversationSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Hermes Live conversation selection must be an object.");
  }
  requireOnlyKeys(value, ["mode", "sessionId", "title"], "conversation selection");
  if (!(["new", "resume", "unbound"].includes(value.mode))) {
    throw new TypeError("Hermes Live conversation mode must be new, resume, or unbound.");
  }
  const sessionId = value.sessionId === undefined ? undefined : requireClientId(value.sessionId, "conversation sessionId");
  const title = optionalBoundedString(value.title, PUBLIC_CONVERSATION_TITLE_MAX_CHARS, "conversation title")?.trim();
  if (value.mode === "resume" && !sessionId) {
    throw new TypeError("Hermes Live resume mode requires a conversation sessionId.");
  }
  if (value.mode !== "resume" && sessionId !== undefined) {
    throw new TypeError("Hermes Live conversation sessionId is valid only in resume mode.");
  }
  if (value.mode !== "new" && title !== undefined) {
    throw new TypeError("Hermes Live conversation title is valid only in new mode.");
  }
  if (value.title !== undefined && !title) {
    throw new TypeError("Hermes Live conversation title cannot be empty.");
  }
  return Object.freeze({
    mode: value.mode,
    ...(sessionId ? { sessionId } : {}),
    ...(title ? { title } : {}),
  });
}

function assertRequestMatches(pending, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (pending[key] !== value) {
      throw new Error(`Hermes Live ${label} did not match its pending ${key}.`);
    }
  }
}

function defaultRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return `req_${globalThis.crypto.randomUUID()}`;
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function encodedMessageSize(data) {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (typeof data?.size === "number") return data.size;
  if (typeof data?.byteLength === "number") return data.byteLength;
  return 0;
}

function parsePcmRate(mimeType) {
  const normalized = String(mimeType ?? "");
  if (normalized.split(";")[0]?.trim().toLowerCase() !== "audio/pcm") {
    throw new Error(`Hermes Live browser audio supports PCM16 output, not ${normalized || "an unknown format"}.`);
  }
  const matches = [...normalized.matchAll(/(?:^|;)\s*rate=(\d+)(?=;|$)/gi)];
  const rate = matches.length === 1 ? Number(matches[0]?.[1]) : Number.NaN;
  if (!Number.isInteger(rate) || rate < MIN_PCM_SAMPLE_RATE || rate > MAX_PCM_SAMPLE_RATE) {
    throw new Error(
      `Hermes Live PCM16 output requires exactly one rate between ${MIN_PCM_SAMPLE_RATE} and ${MAX_PCM_SAMPLE_RATE} Hz.`,
    );
  }
  return rate;
}

function isPcmMimeType(mimeType) {
  return String(mimeType).split(";")[0]?.trim().toLowerCase() === "audio/pcm";
}

function decodePcm16(data, decodeBase64) {
  const binary = decodeBase64(data);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength % 2 !== 0) throw new Error("Hermes Live returned an unaligned PCM16 audio frame.");
  const samples = new Float32Array(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
}

function preparePlaybackFrame(message, decodeBase64) {
  if (message?.type !== "audio.output" || typeof message.data !== "string") {
    throw new TypeError("HermesLiveAudio.play expects an audio.output message.");
  }
  const rate = parsePcmRate(message.mimeType);
  const samples = decodePcm16(message.data, decodeBase64);
  if (samples.length === 0) throw new Error("Hermes Live returned an empty PCM16 audio frame.");
  return {
    rate,
    samples,
    durationMs: (samples.length / rate) * 1_000,
    itemId: typeof message.itemId === "string" ? message.itemId : "",
    contentIndex: Number.isInteger(message.contentIndex) ? message.contentIndex : 0,
  };
}

function createPlaybackEpoch() {
  let invalidate;
  const invalidated = new Promise((resolve) => {
    invalidate = resolve;
  });
  return { invalidated, invalidate };
}

function createCaptureCancellation() {
  let finish;
  const signal = {
    cancelled: false,
    promise: new Promise((resolve) => {
      finish = resolve;
    }),
    cancel() {
      if (signal.cancelled) return;
      signal.cancelled = true;
      finish();
    },
  };
  return signal;
}

async function capturePrerequisite(promise, cancellation, disposeLateValue) {
  const settled = Promise.resolve(promise).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error: toError(error) }),
  );
  const result = await Promise.race([
    settled,
    cancellation.promise.then(() => ({ status: "cancelled" })),
  ]);
  if (result.status === "cancelled" || cancellation.cancelled) {
    if (disposeLateValue) {
      void settled.then((lateResult) => {
        if (lateResult.status !== "fulfilled") return undefined;
        return disposeLateValue(lateResult.value);
      }).catch(() => undefined);
    }
    throw abortError();
  }
  if (result.status === "rejected") throw result.error;
  return result.value;
}

function playbackDeadline(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => finish(undefined, value),
      (error) => finish(toError(error)),
    );
  });
}

async function cleanupCapture({ stream, context, source, node }) {
  try {
    node?.disconnect();
  } catch {}
  try {
    source?.disconnect();
  } catch {}
  try {
    stream?.getTracks?.().forEach((track) => {
      try {
        track.stop();
      } catch {}
    });
  } catch {}
  if (context && context.state !== "closed") {
    try {
      void Promise.resolve(context.close()).catch(() => undefined);
    } catch {
      // Media tracks are already stopped; browser context teardown is best effort.
    }
  }
}

function trimOldestMapEntries(map, maximum) {
  while (map.size > maximum) map.delete(map.keys().next().value);
}

function closeSocket(socket, code, reason) {
  if (socket.readyState !== OPEN && socket.readyState !== 0) return;
  const closeCode = normalizeClientCloseCode(code);
  const closeReason = normalizeCloseReason(reason);
  try {
    socket.close(closeCode, closeReason);
  } catch {
    try {
      socket.close();
    } catch {
      // The socket is already unusable; cleanup callers must not fail again.
    }
  }
}

function normalizeClientCloseCode(value) {
  const code = Number(value);
  return code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999)
    ? code
    : 4000;
}

function normalizeCloseReason(value) {
  const source = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 123);
  if (typeof TextEncoder !== "function") return Array.from(source).slice(0, 30).join("");
  const encoder = new TextEncoder();
  if (encoder.encode(source).byteLength <= 123) return source;
  let result = "";
  for (const character of source) {
    const candidate = result + character;
    if (encoder.encode(candidate).byteLength > 123) break;
    result = candidate;
  }
  return result;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function settleConnectionPrerequisite(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(abortError());
    const timeout = setTimeout(
      () => finish(new Error(`Hermes Live gateway URL or token did not resolve within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(undefined, value),
      (error) => finish(toError(error)),
    );
  });
}

function optionalString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function abortError() {
  const error = new Error("Hermes Live operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
