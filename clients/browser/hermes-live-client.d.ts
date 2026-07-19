export type HermesLiveClientState =
  | "idle"
  | "connecting"
  | "starting"
  | "ready"
  | "closing"
  | "closed"
  | "failed";

export const HERMES_LIVE_PROTOCOL_VERSION: 4;

export type HermesLiveConversationSelection =
  | { mode: "new"; title?: string }
  | { mode: "resume"; sessionId: string }
  | { mode: "unbound" };

export interface HermesLiveConversation {
  mode: "new" | "resume" | "unbound";
  sessionId?: string;
  title?: string;
  source?: string;
  preview?: string;
  lastActiveAt?: number;
}

export type HermesLiveTaskState =
  | "accepted"
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface HermesLiveTaskProgress {
  message: string;
  stage?: string;
  current?: number;
  total?: number;
  percent?: number;
}

export interface HermesLiveTaskResult {
  summary?: string;
  output?: string;
  truncated: boolean;
  usage?: Record<string, unknown>;
}

export interface HermesLiveTaskError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface HermesLiveTask {
  taskId: string;
  kind?: "background" | "follow_up";
  parentTaskId?: string;
  rootTaskId?: string;
  sequence: number;
  state: HermesLiveTaskState;
  title?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress?: HermesLiveTaskProgress;
  result?: HermesLiveTaskResult;
  error?: HermesLiveTaskError;
}

export interface HermesLiveTaskNotification {
  notificationId: string;
  kind: "completed" | "failed" | "cancelled" | "unknown";
  delivery: "interrupt" | "when_idle" | "silent";
  message: string;
  createdAt: number;
  acknowledged: boolean;
}

export type HermesLiveUnreadNotification = HermesLiveTaskNotification & { taskId: string };

export interface HermesLiveTaskCapabilities {
  scope: "owner";
  sequence: "per_task";
  reconnect: "snapshot";
  durable: boolean;
  parallel: boolean;
  maxConcurrent: number;
  maxRetained: number;
  supports: {
    list: boolean;
    get: boolean;
    stop: boolean;
    followUp: boolean;
    resume: false;
    notificationAck: boolean;
  };
}

export interface HermesLiveSessionReady {
  type: "session.ready";
  protocolVersion: 4;
  requestId?: string;
  sessionId: string;
  model: string;
  hermes: { model?: string; capabilities?: Record<string, unknown> };
  realtime: {
    provider: "gemini" | "openai" | "mock";
    model: string;
    audio: {
      input: { enabled: boolean; mimeType?: string; recommendedFrameMs?: number };
      output: { enabled: boolean; mimeType?: string };
      turnDetection: "disabled" | "semantic_vad" | "server_vad" | "provider" | "none";
    };
  };
  tasks: HermesLiveTaskCapabilities;
  conversation: HermesLiveConversation;
}

export interface HermesLiveTruncation {
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}

export interface HermesLiveTaskEventBase {
  taskId: string;
  sequence: number;
  occurredAt: number;
}

export type HermesLiveKnownServerMessage =
  | HermesLiveSessionReady
  | { type: "session.error"; code: string; message: string; requestId?: string; recoverable?: boolean }
  | { type: "audio.output"; data: string; mimeType: string; itemId?: string; contentIndex?: number }
  | { type: "transcript.delta"; speaker: "user" | "assistant" | "system"; text: string; final?: boolean }
  | { type: "input.speech_started"; provider: "openai"; itemId?: string; audioStartMs?: number }
  | { type: "response.started"; responseId?: string }
  | { type: "response.completed"; responseId?: string }
  | { type: "response.cancelled"; responseId?: string }
  | { type: "response.failed"; responseId?: string; error: string }
  | { type: "task.snapshot"; reason: "initial" | "reconnect" | "list" | "get"; requestId?: string; tasks: HermesLiveTask[]; truncated: boolean }
  | (HermesLiveTaskEventBase & {
      type: "task.accepted";
      requestId?: string;
      state: "accepted" | "queued";
      title?: string;
      kind?: "background" | "follow_up";
      parentTaskId?: string;
      rootTaskId?: string;
    })
  | (HermesLiveTaskEventBase & { type: "task.started"; title?: string })
  | (HermesLiveTaskEventBase & { type: "task.progress"; progress: HermesLiveTaskProgress })
  | (HermesLiveTaskEventBase & { type: "task.stopping"; requestId?: string; reason?: string })
  | (HermesLiveTaskEventBase & { type: "task.completed"; requestId?: string; result: HermesLiveTaskResult })
  | (HermesLiveTaskEventBase & { type: "task.failed"; requestId?: string; error: HermesLiveTaskError })
  | (HermesLiveTaskEventBase & { type: "task.cancelled"; requestId?: string; reason?: string })
  | (HermesLiveTaskEventBase & { type: "task.unknown"; requestId?: string; error: HermesLiveTaskError })
  | (HermesLiveTaskEventBase & {
      type: "task.notification";
      requestId?: string;
      notification: HermesLiveTaskNotification;
    })
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; data?: Record<string, unknown> };

export type HermesLiveUnknownServerMessage = Record<string, unknown> & { type: string };
export type HermesLiveServerMessage = HermesLiveKnownServerMessage | HermesLiveUnknownServerMessage;

export interface HermesLiveClientOptions {
  url?: string | URL;
  webSocketUrlProvider?: () => string | URL | Promise<string | URL>;
  token?: string | (() => string | undefined | Promise<string | undefined>);
  profileId?: string;
  userLabel?: string;
  conversation?: HermesLiveConversationSelection;
  connectTimeoutMs?: number;
  disconnectTimeoutMs?: number;
  maxBufferedAmountBytes?: number;
  maxInboundMessageBytes?: number;
  webSocketFactory?: (url: URL) => WebSocket;
  requestIdFactory?: () => string;
}

export interface HermesLiveClientError {
  error: Error;
  code: string;
  detail?: unknown;
}

export interface HermesLiveSnapshot {
  connection: HermesLiveClientState;
  session?: HermesLiveSessionReady;
  tasks: readonly HermesLiveTask[];
  activeTasks: readonly HermesLiveTask[];
  recentTasks: readonly HermesLiveTask[];
  unreadNotifications: readonly HermesLiveUnreadNotification[];
  lastError?: HermesLiveClientError;
}

export type HermesLivePendingRequest =
  | { type: "task.list" }
  | { type: "task.get"; taskId: string }
  | { type: "task.follow_up"; taskId: string }
  | { type: "task.stop"; taskId: string }
  | { type: "task.notification.ack"; taskId: string; notificationId: string };

export interface HermesLiveClientEventMap {
  state: { state: HermesLiveClientState; previous: HermesLiveClientState };
  statechange: { state: HermesLiveClientState; previous: HermesLiveClientState };
  snapshot: HermesLiveSnapshot;
  message: HermesLiveServerMessage;
  unknownmessage: Record<string, unknown> & { type: string };
  error: HermesLiveClientError;
  close: { code: number; reason: string; clean: boolean };
  "audio.dropped": { id: string; direction: "input"; reason: string; bufferedAmount: number };
  "session.ready": Extract<HermesLiveKnownServerMessage, { type: "session.ready" }>;
  "session.error": Extract<HermesLiveKnownServerMessage, { type: "session.error" }>;
  "audio.output": Extract<HermesLiveKnownServerMessage, { type: "audio.output" }>;
  "transcript.delta": Extract<HermesLiveKnownServerMessage, { type: "transcript.delta" }>;
  "input.speech_started": Extract<HermesLiveKnownServerMessage, { type: "input.speech_started" }>;
  "response.started": Extract<HermesLiveKnownServerMessage, { type: "response.started" }>;
  "response.completed": Extract<HermesLiveKnownServerMessage, { type: "response.completed" }>;
  "response.cancelled": Extract<HermesLiveKnownServerMessage, { type: "response.cancelled" }>;
  "response.failed": Extract<HermesLiveKnownServerMessage, { type: "response.failed" }>;
  "task.snapshot": Extract<HermesLiveKnownServerMessage, { type: "task.snapshot" }>;
  "task.accepted": Extract<HermesLiveKnownServerMessage, { type: "task.accepted" }>;
  "task.started": Extract<HermesLiveKnownServerMessage, { type: "task.started" }>;
  "task.progress": Extract<HermesLiveKnownServerMessage, { type: "task.progress" }>;
  "task.stopping": Extract<HermesLiveKnownServerMessage, { type: "task.stopping" }>;
  "task.completed": Extract<HermesLiveKnownServerMessage, { type: "task.completed" }>;
  "task.failed": Extract<HermesLiveKnownServerMessage, { type: "task.failed" }>;
  "task.cancelled": Extract<HermesLiveKnownServerMessage, { type: "task.cancelled" }>;
  "task.unknown": Extract<HermesLiveKnownServerMessage, { type: "task.unknown" }>;
  "task.notification": Extract<HermesLiveKnownServerMessage, { type: "task.notification" }>;
  "task.updated": { task: HermesLiveTask; message: Extract<HermesLiveKnownServerMessage, HermesLiveTaskEventBase> };
  "task.stale": { taskId: string; type: string; sequence: number; currentSequence: number };
  "tasks.changed": { tasks: readonly HermesLiveTask[]; activeTasks: readonly HermesLiveTask[]; recentTasks: readonly HermesLiveTask[] };
  "tasks.reconciled": { reason: "initial" | "reconnect" | "list" | "get"; requestId?: string; tasks: readonly HermesLiveTask[]; truncated: boolean };
  "notifications.changed": readonly HermesLiveUnreadNotification[];
  "request.failed": { requestId: string; request: HermesLivePendingRequest; error: Extract<HermesLiveKnownServerMessage, { type: "session.error" }> };
  "request.succeeded": { requestId: string; request: HermesLivePendingRequest; response: HermesLiveKnownServerMessage };
  log: Extract<HermesLiveKnownServerMessage, { type: "log" }>;
  "listener.error": { type: keyof HermesLiveClientEventMap; error: Error };
}

export class HermesLiveClient {
  constructor(options: HermesLiveClientOptions);
  readonly configuredUrl?: string;
  readonly state: HermesLiveClientState;
  readonly connected: boolean;
  readonly session?: HermesLiveSessionReady;
  readonly tasks: readonly HermesLiveTask[];
  readonly activeTasks: readonly HermesLiveTask[];
  readonly recentTasks: readonly HermesLiveTask[];
  on<K extends keyof HermesLiveClientEventMap>(type: K, listener: (event: HermesLiveClientEventMap[K]) => void): () => void;
  subscribe(listener: (snapshot: HermesLiveSnapshot) => void): () => void;
  getSnapshot(): HermesLiveSnapshot;
  connect(options?: { signal?: AbortSignal; conversation?: HermesLiveConversationSelection }): Promise<HermesLiveSessionReady>;
  disconnect(reason?: string): Promise<void>;
  sendText(text: string, options?: { id?: string }): string;
  sendAudio(data: string | ArrayBuffer | ArrayBufferView, mimeType?: string, options?: { id?: string }): string | undefined;
  endAudio(options?: { id?: string }): string;
  cancelResponse(reason?: string, truncate?: HermesLiveTruncation, options?: { id?: string }): string;
  listTasks(options?: { id?: string; limit?: number }): string;
  getTask(taskId: string, options?: { id?: string }): string;
  followUpTask(taskId: string, message: string, options?: { id?: string; title?: string }): string;
  stopTask(taskId: string, reason?: string, options?: { id?: string }): string;
  acknowledgeNotification(taskId: string, notificationId: string, options?: { id?: string }): string;
  sendMessage(message: Record<string, unknown> & { type: string; id?: string }): string;
}

export interface HermesLiveAudioOptions {
  workletUrl?: string;
  sampleRate?: number;
  maxQueuedAudioMs?: number;
  maxQueuedAudioFrames?: number;
  playbackResumeTimeoutMs?: number;
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  audioContextFactory?: (options: AudioContextOptions) => AudioContext;
  audioWorkletNodeFactory?: (
    context: AudioContext,
    name: string,
    options?: AudioWorkletNodeOptions,
  ) => AudioWorkletNode;
  decodeBase64?: (value: string) => string;
}

export interface HermesLiveAudioEventMap {
  microphone: { state: "idle" | "starting" | "active" | "stopping" | "disposed"; active: boolean; sampleRate?: number };
  playback: { active: boolean; queued: number; queuedMs: number };
  error: { error: Error; code: string };
  "audio.dropped": { direction: "output"; reason: string; queuedMs: number; droppedMs: number };
}

export class HermesLiveAudio {
  constructor(client: HermesLiveClient, options?: HermesLiveAudioOptions);
  readonly microphoneActive: boolean;
  readonly microphoneState: "idle" | "starting" | "active" | "stopping" | "disposed";
  on<K extends keyof HermesLiveAudioEventMap>(type: K, listener: (event: HermesLiveAudioEventMap[K]) => void): () => void;
  primePlayback(): Promise<void>;
  startMicrophone(): Promise<void>;
  stopMicrophone(options?: { endTurn?: boolean }): Promise<void>;
  play(message: Extract<HermesLiveKnownServerMessage, { type: "audio.output" }>): Promise<boolean>;
  interrupt(reason?: string): HermesLiveTruncation | undefined;
  clearPlayback(): HermesLiveTruncation | undefined;
  dispose(): Promise<void>;
}

export function normalizeGatewayWebSocketUrl(value: string | URL): string;
export function buildGatewayWebSocketUrl(baseUrl: string | URL, token?: string): URL;
export function arrayBufferToBase64(value: ArrayBuffer | ArrayBufferView): string;
export function validateServerMessage(value: unknown): HermesLiveServerMessage;
