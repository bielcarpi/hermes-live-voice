const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 1_000_000;
const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 8_000_000;
const DEFAULT_MAX_QUEUED_AUDIO_MS = 30_000;
const DEFAULT_SAMPLE_RATE = 24_000;
const OPEN = 1;
export const HERMES_LIVE_PROTOCOL_VERSION = 1;

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
  "realtime.message",
  "run.started",
  "run.event",
  "approval.request",
  "approval.responded",
  "run.completed",
  "run.failed",
  "run.stopped",
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
    this.connectTimeoutMs = positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
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
    this.activeRunId = "";
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

  async connect(options = {}) {
    if (this.connected && this.session) return this.session;
    if (this.connectPromise) return this.connectPromise;
    if (options.signal?.aborted) throw abortError();

    const generation = ++this.generation;
    this.setState("connecting");
    const attempt = this.openConnection(generation, options.signal);
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

  async openConnection(generation, signal) {
    const socketUrl = await this.resolveSocketUrl();
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
      const timeout = setTimeout(() => {
        const error = new Error(`Hermes Live session did not become ready within ${this.connectTimeoutMs}ms.`);
        failStartup(error, "connect_timeout");
        closeSocket(socket, 4000, "session ready timeout");
      }, this.connectTimeoutMs);
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
          this.sendRaw({
            type: "session.start",
            id: this.createRequestId(),
            protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
            ...(this.profileId ? { profileId: this.profileId } : {}),
            ...(this.userLabel ? { userLabel: this.userLabel } : {}),
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
        this.activeRunId = "";
        this.setState("closed");
        this.updateSnapshot({
          session: undefined,
          run: { state: "idle" },
          pendingApprovals: [],
        });
        const closeEvent = {
          code: Number(event.code ?? 1006),
          reason: String(event.reason ?? ""),
          clean: Boolean(event.wasClean),
        };
        this.emitter.emit("close", closeEvent);
        if (!ready) {
          finish(new Error(`Hermes Live connection closed before session readiness (${closeEvent.code}).`));
        } else if (!closeEvent.clean && closeEvent.code !== 1000) {
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
      this.activeRunId = "";
      this.setState("closed");
      return;
    }
    this.setState("closing");
    if (socket.readyState === OPEN) {
      try {
        this.sendRaw({ type: "session.close", id: this.createRequestId() });
      } catch {
        // The close below is authoritative.
      }
    }
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 1_000);
      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      closeSocket(socket, 1000, reason);
    });
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

  stopRun(reason = "user stopped Hermes run", runId = this.activeRunId, options = {}) {
    if (!runId) throw new Error("There is no active Hermes run to stop.");
    const id = options.id ?? this.createRequestId();
    this.send({ type: "run.stop", id, runId, reason });
    this.updateSnapshot({ run: { state: "stopping", runId } });
    return id;
  }

  respondToApproval(choice, runId = this.activeRunId, options = {}) {
    if (!runId) throw new Error("An approval response requires an active Hermes run ID.");
    if (!["once", "session", "always", "deny"].includes(choice)) {
      throw new TypeError(`Unsupported Hermes approval choice: ${choice}`);
    }
    const id = options.id ?? this.createRequestId();
    this.send({
      type: "approval.respond",
      id,
      runId,
      choice,
      ...(options.resolveAll === undefined ? {} : { resolveAll: Boolean(options.resolveAll) }),
    });
    return id;
  }

  sendMessage(message) {
    const id = message.id ?? this.createRequestId();
    this.send({ ...message, id });
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
    if (text.length > this.maxInboundMessageBytes) {
      throw new Error("Hermes Live server message exceeded the configured client limit.");
    }
    return validateServerMessage(JSON.parse(text));
  }

  acceptMessage(message) {
    switch (message.type) {
      case "session.ready":
        this.session = message;
        this.setState("ready");
        this.updateSnapshot({ session: message, lastError: undefined });
        break;
      case "run.started":
        this.activeRunId = message.runId;
        this.updateSnapshot({ run: { state: "running", runId: message.runId } });
        break;
      case "approval.request":
        this.activeRunId = message.runId;
        this.updateSnapshot({
          run: { state: "running", runId: message.runId },
          pendingApprovals: [
            ...this.snapshot.pendingApprovals.filter((entry) => entry.event?.approval_id !== message.event?.approval_id),
            message,
          ],
        });
        break;
      case "approval.responded":
        this.updateSnapshot({
          pendingApprovals: this.snapshot.pendingApprovals.filter((entry) => entry.runId !== message.runId),
        });
        break;
      case "run.completed":
      case "run.failed":
      case "run.stopped": {
        if (!message.runId || message.runId === this.activeRunId) this.activeRunId = "";
        const status = message.type === "run.completed" ? "completed" : message.type === "run.failed" ? "failed" : "stopped";
        this.updateSnapshot({
          run: { state: "idle" },
          lastRun: {
            runId: message.runId,
            status,
            ...(message.output ? { output: message.output } : {}),
            ...(message.error ? { error: message.error } : {}),
          },
          pendingApprovals: this.snapshot.pendingApprovals.filter((entry) => entry.runId !== message.runId),
        });
        break;
      }
      case "session.error":
        this.emitError(new Error(message.message), message.code, message);
        break;
    }
    this.emitter.emit("message", message);
    if (KNOWN_SERVER_MESSAGE_TYPES.has(message.type)) this.emitter.emit(message.type, message);
    else this.emitter.emit("unknownmessage", message);
  }

  isCurrentSocket(socket, generation) {
    return this.socket === socket && this.generation === generation;
  }

  createRequestId() {
    const id = String(this.requestIdFactory());
    if (!id || id.length > 128) throw new Error("Hermes Live requestIdFactory returned an invalid ID.");
    return id;
  }

  setState(next) {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    this.snapshot = { ...this.snapshot, connection: next };
    const event = { state: next, previous };
    this.emitter.emit("statechange", event);
    this.emitter.emit("state", event);
    this.emitter.emit("snapshot", this.snapshot);
  }

  updateSnapshot(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emitter.emit("snapshot", this.snapshot);
  }

  emitError(error, code, detail) {
    const event = { error, code, ...(detail === undefined ? {} : { detail }) };
    this.snapshot = { ...this.snapshot, lastError: event };
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
    this.microphoneStopPromise = undefined;
    this.disposed = false;
    this.playbackContext = undefined;
    this.playbackCursor = 0;
    this.playbackSources = new Set();
    this.playbackItems = new Map();
    this.playbackChain = Promise.resolve();
    this.playbackGeneration = 0;
    this.unsubscribeClose = client.on?.("close", () => void this.dispose());
  }

  on(type, listener) {
    return this.emitter.on(type, listener);
  }

  get microphoneActive() {
    return this.microphoneState === "active";
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
    this.setMicrophoneState("starting");
    const start = this.startMicrophonePipeline(generation, negotiatedInput);
    this.microphoneStartPromise = start;
    try {
      await start;
    } finally {
      if (this.microphoneStartPromise === start) this.microphoneStartPromise = undefined;
    }
  }

  async startMicrophonePipeline(generation, negotiatedInput) {
    let stream;
    let context;
    let source;
    let node;
    try {
      stream = await this.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      this.assertCaptureGeneration(generation);
      const negotiatedRate = negotiatedInput?.mimeType ? parsePcmRate(negotiatedInput.mimeType) : this.sampleRate;
      context = this.audioContextFactory({ sampleRate: negotiatedRate });
      if (context.state === "suspended") await context.resume();
      this.assertCaptureGeneration(generation);
      await context.audioWorklet.addModule(this.workletUrl);
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
    const generation = this.playbackGeneration;
    const operation = this.playbackChain.then(() => this.schedulePlayback(message, generation));
    this.playbackChain = operation.catch(() => undefined);
    return operation;
  }

  async schedulePlayback(message, generation) {
    if (this.disposed || generation !== this.playbackGeneration) return false;
    if (message?.type !== "audio.output") {
      throw new TypeError("HermesLiveAudio.play expects an audio.output message.");
    }
    const rate = parsePcmRate(message.mimeType);
    const samples = decodePcm16(message.data, this.decodeBase64);
    const durationMs = (samples.length / rate) * 1_000;

    if (!this.playbackContext || this.playbackContext.state === "closed") {
      this.playbackContext = this.audioContextFactory({});
      this.playbackCursor = 0;
    }
    if (this.playbackContext.state === "suspended") await this.playbackContext.resume();
    if (this.disposed || generation !== this.playbackGeneration) return false;

    const context = this.playbackContext;
    const queuedMs = this.calculateQueuedPlaybackMs(context.currentTime);
    if (queuedMs + durationMs > this.maxQueuedAudioMs) {
      this.emitter.emit("audio.dropped", {
        direction: "output",
        reason: "playback_backpressure",
        queuedMs,
        droppedMs: durationMs,
      });
      return false;
    }

    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.02, this.playbackCursor || 0);
    const contentIndex = Number.isInteger(message.contentIndex) ? message.contentIndex : 0;
    const itemKey = message.itemId ? `${message.itemId}:${contentIndex}` : "";
    if (itemKey && !this.playbackItems.has(itemKey)) {
      this.playbackItems.set(itemKey, { itemId: message.itemId, contentIndex, playedMs: 0 });
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
    const truncate = this.clearPlayback();
    if (this.client.connected) this.client.cancelResponse(reason, truncate);
    return truncate;
  }

  clearPlayback() {
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

  async closePlaybackContext() {
    this.clearPlayback();
    const context = this.playbackContext;
    this.playbackContext = undefined;
    if (context && context.state !== "closed") await context.close();
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
    await this.playbackChain.catch(() => undefined);
    await this.closePlaybackContext();
    this.unsubscribeClose?.();
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
    case "session.ready":
      requireNumber(message, "protocolVersion");
      if (message.protocolVersion !== HERMES_LIVE_PROTOCOL_VERSION) {
        throw new TypeError(
          `Hermes Live protocol version ${message.protocolVersion} is not supported by this client.`,
        );
      }
      requireString(message, "sessionId");
      requireString(message, "model");
      requireObject(message, "hermes");
      requireObject(message, "realtime");
      validateRealtimeCapabilities(message.realtime);
      break;
    case "session.error":
      requireString(message, "code");
      requireString(message, "message");
      break;
    case "audio.output":
      requireString(message, "data");
      requireString(message, "mimeType");
      break;
    case "transcript.delta":
      requireString(message, "speaker");
      requireString(message, "text", true);
      break;
    case "input.speech_started":
      requireString(message, "provider");
      break;
    case "response.started":
    case "response.completed":
    case "response.cancelled":
      break;
    case "response.failed":
      requireString(message, "error");
      break;
    case "run.started":
      requireString(message, "runId");
      requireString(message, "sessionId");
      break;
    case "run.event":
      requireString(message, "runId");
      requireObject(message, "event");
      break;
    case "approval.request":
      requireString(message, "runId");
      requireObject(message, "event");
      requireObject(message, "approval");
      break;
    case "approval.responded":
      requireString(message, "runId");
      requireString(message, "choice");
      break;
    case "run.completed":
      requireString(message, "runId");
      requireString(message, "output", true);
      break;
    case "run.failed":
      requireString(message, "runId");
      requireString(message, "error");
      break;
    case "run.stopped":
      requireString(message, "runId");
      requireString(message, "status");
      break;
    case "log":
      requireString(message, "level");
      requireString(message, "message", true);
      break;
  }
  return message;
}

function requireString(value, key, allowEmpty = false) {
  if (typeof value[key] !== "string" || (!allowEmpty && value[key].length === 0)) {
    throw new TypeError(`Hermes Live ${value.type} message requires ${key}.`);
  }
}

function requireObject(value, key) {
  if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key])) {
    throw new TypeError(`Hermes Live ${value.type} message requires ${key}.`);
  }
}

function requireNumber(value, key) {
  if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
    throw new TypeError(`Hermes Live ${value.type} message requires ${key}.`);
  }
}

function validateRealtimeCapabilities(value) {
  requireString({ type: "session.ready realtime", ...value }, "provider");
  requireString({ type: "session.ready realtime", ...value }, "model");
  requireObject({ type: "session.ready realtime", ...value }, "audio");
  const audio = value.audio;
  requireObject({ type: "session.ready realtime audio", ...audio }, "input");
  requireObject({ type: "session.ready realtime audio", ...audio }, "output");
  requireString({ type: "session.ready realtime audio", ...audio }, "turnDetection");
  if (typeof audio.input.enabled !== "boolean" || typeof audio.output.enabled !== "boolean") {
    throw new TypeError("Hermes Live session.ready realtime audio capabilities require enabled flags.");
  }
  if (audio.input.enabled) requireString({ type: "session.ready realtime audio input", ...audio.input }, "mimeType");
  if (audio.output.enabled) requireString({ type: "session.ready realtime audio output", ...audio.output }, "mimeType");
}

function createSnapshot(connection) {
  return {
    connection,
    session: undefined,
    run: { state: "idle" },
    lastRun: undefined,
    pendingApprovals: [],
    lastError: undefined,
  };
}

function defaultRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return `req_${globalThis.crypto.randomUUID()}`;
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function encodedMessageSize(data) {
  if (typeof data === "string") return data.length;
  if (typeof data?.size === "number") return data.size;
  if (typeof data?.byteLength === "number") return data.byteLength;
  return 0;
}

function parsePcmRate(mimeType) {
  const normalized = String(mimeType ?? "");
  if (normalized.split(";")[0]?.trim().toLowerCase() !== "audio/pcm") {
    throw new Error(`Hermes Live browser audio supports PCM16 output, not ${normalized || "an unknown format"}.`);
  }
  const match = /(?:^|;)\s*rate=(\d+)(?:;|$)/i.exec(normalized);
  return positiveInteger(match?.[1], DEFAULT_SAMPLE_RATE);
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

async function cleanupCapture({ stream, context, source, node }) {
  try {
    node?.disconnect();
  } catch {}
  try {
    source?.disconnect();
  } catch {}
  stream?.getTracks?.().forEach((track) => track.stop());
  if (context && context.state !== "closed") await context.close().catch(() => undefined);
}

function trimOldestMapEntries(map, maximum) {
  while (map.size > maximum) map.delete(map.keys().next().value);
}

function closeSocket(socket, code, reason) {
  if (socket.readyState === OPEN || socket.readyState === 0) socket.close(code, reason);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
