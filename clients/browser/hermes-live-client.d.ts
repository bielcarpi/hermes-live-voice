export type HermesLiveClientState =
  | "idle"
  | "connecting"
  | "starting"
  | "ready"
  | "closing"
  | "closed"
  | "failed";

export type HermesApprovalChoice = "once" | "session" | "always" | "deny";
export const HERMES_LIVE_PROTOCOL_VERSION: 1;
export type HermesRunEvent = Record<string, unknown> & { event?: string; approval_id?: string };

export interface HermesLiveSessionReady {
  type: "session.ready";
  protocolVersion: 1;
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
  [key: string]: unknown;
}

export interface HermesLiveTruncation {
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}

export type HermesLiveServerMessage =
  | HermesLiveSessionReady
  | { type: "session.error"; code: string; message: string; requestId?: string; recoverable?: boolean }
  | { type: "audio.output"; data: string; mimeType: string; itemId?: string; contentIndex?: number }
  | { type: "transcript.delta"; speaker: "user" | "assistant" | "system"; text: string; final?: boolean }
  | { type: "input.speech_started"; provider: string; itemId?: string; audioStartMs?: number }
  | { type: "response.started"; responseId?: string }
  | { type: "response.completed"; responseId?: string }
  | { type: "response.cancelled"; responseId?: string }
  | { type: "response.failed"; responseId?: string; error: string }
  | { type: "realtime.message"; message: unknown }
  | { type: "run.started"; runId: string; sessionId: string }
  | { type: "run.event"; runId: string; event: HermesRunEvent }
  | {
      type: "approval.request";
      runId: string;
      event: HermesRunEvent;
      approval: {
        approvalId?: string;
        command?: string;
        description?: string;
        patternKey?: string;
        patternKeys?: string[];
        choices: HermesApprovalChoice[];
        allowPermanent: boolean;
      };
    }
  | { type: "approval.responded"; runId: string; choice: HermesApprovalChoice; resolved?: number }
  | { type: "run.completed"; runId: string; output: string; usage?: Record<string, unknown> }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.stopped"; runId: string; status: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; data?: unknown }
  | (Record<string, unknown> & { type: string });

export interface HermesLiveClientOptions {
  url?: string | URL;
  webSocketUrlProvider?: () => string | URL | Promise<string | URL>;
  token?: string | (() => string | undefined | Promise<string | undefined>);
  profileId?: string;
  userLabel?: string;
  connectTimeoutMs?: number;
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
  run: { state: "idle" } | { state: "running" | "stopping"; runId: string };
  lastRun?: { runId: string; status: "completed" | "failed" | "stopped"; output?: string; error?: string };
  pendingApprovals: Array<Extract<HermesLiveServerMessage, { type: "approval.request" }>>;
  lastError?: HermesLiveClientError;
}

export interface HermesLiveClientEventMap {
  state: { state: HermesLiveClientState; previous: HermesLiveClientState };
  statechange: { state: HermesLiveClientState; previous: HermesLiveClientState };
  snapshot: HermesLiveSnapshot;
  message: HermesLiveServerMessage;
  unknownmessage: Record<string, unknown> & { type: string };
  error: HermesLiveClientError;
  close: { code: number; reason: string; clean: boolean };
  "audio.dropped": { id: string; direction: "input"; reason: string; bufferedAmount: number };
  "session.ready": Extract<HermesLiveServerMessage, { type: "session.ready" }>;
  "session.error": Extract<HermesLiveServerMessage, { type: "session.error" }>;
  "audio.output": Extract<HermesLiveServerMessage, { type: "audio.output" }>;
  "transcript.delta": Extract<HermesLiveServerMessage, { type: "transcript.delta" }>;
  "input.speech_started": Extract<HermesLiveServerMessage, { type: "input.speech_started" }>;
  "response.started": Extract<HermesLiveServerMessage, { type: "response.started" }>;
  "response.completed": Extract<HermesLiveServerMessage, { type: "response.completed" }>;
  "response.cancelled": Extract<HermesLiveServerMessage, { type: "response.cancelled" }>;
  "response.failed": Extract<HermesLiveServerMessage, { type: "response.failed" }>;
  "run.started": Extract<HermesLiveServerMessage, { type: "run.started" }>;
  "run.event": Extract<HermesLiveServerMessage, { type: "run.event" }>;
  "approval.request": Extract<HermesLiveServerMessage, { type: "approval.request" }>;
  "approval.responded": Extract<HermesLiveServerMessage, { type: "approval.responded" }>;
  "run.completed": Extract<HermesLiveServerMessage, { type: "run.completed" }>;
  "run.failed": Extract<HermesLiveServerMessage, { type: "run.failed" }>;
  "run.stopped": Extract<HermesLiveServerMessage, { type: "run.stopped" }>;
  log: Extract<HermesLiveServerMessage, { type: "log" }>;
  "realtime.message": Extract<HermesLiveServerMessage, { type: "realtime.message" }>;
  "listener.error": { type: keyof HermesLiveClientEventMap; error: Error };
}

export class HermesLiveClient {
  constructor(options: HermesLiveClientOptions);
  readonly configuredUrl?: string;
  readonly state: HermesLiveClientState;
  readonly connected: boolean;
  readonly activeRunId: string;
  readonly session?: HermesLiveSessionReady;
  on<K extends keyof HermesLiveClientEventMap>(type: K, listener: (event: HermesLiveClientEventMap[K]) => void): () => void;
  subscribe(listener: (snapshot: HermesLiveSnapshot) => void): () => void;
  getSnapshot(): HermesLiveSnapshot;
  connect(options?: { signal?: AbortSignal }): Promise<HermesLiveSessionReady>;
  disconnect(reason?: string): Promise<void>;
  sendText(text: string, options?: { id?: string }): string;
  sendAudio(data: string | ArrayBuffer | ArrayBufferView, mimeType?: string, options?: { id?: string }): string | undefined;
  endAudio(options?: { id?: string }): string;
  cancelResponse(reason?: string, truncate?: HermesLiveTruncation, options?: { id?: string }): string;
  stopRun(reason?: string, runId?: string, options?: { id?: string }): string;
  respondToApproval(
    choice: HermesApprovalChoice,
    runId?: string,
    options?: { id?: string; resolveAll?: boolean },
  ): string;
  sendMessage(message: Record<string, unknown> & { type: string; id?: string }): string;
}

export interface HermesLiveAudioOptions {
  workletUrl?: string;
  sampleRate?: number;
  maxQueuedAudioMs?: number;
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
  startMicrophone(): Promise<void>;
  stopMicrophone(options?: { endTurn?: boolean }): Promise<void>;
  play(message: Extract<HermesLiveServerMessage, { type: "audio.output" }>): Promise<boolean>;
  interrupt(reason?: string): HermesLiveTruncation | undefined;
  clearPlayback(): HermesLiveTruncation | undefined;
  dispose(): Promise<void>;
}

export function normalizeGatewayWebSocketUrl(value: string | URL): string;
export function buildGatewayWebSocketUrl(baseUrl: string | URL, token?: string): URL;
export function arrayBufferToBase64(value: ArrayBuffer | ArrayBufferView): string;
export function validateServerMessage(value: unknown): HermesLiveServerMessage;
