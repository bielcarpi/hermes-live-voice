import WebSocket from "ws";
import { normalizePcm16Audio } from "../../../domain/audio/pcm.js";
import { errorToMessage } from "../../../domain/error-message.js";
import type { RealtimeResponseTruncation } from "../../../domain/protocol/client-protocol.js";
import type { AppConfig } from "../../../config.js";
import { OPENAI_HERMES_LIVE_TOOLS } from "../../../application/live-gateway/tool-definitions.js";
import type {
  LiveModelAdapter,
  LiveModelCallbacks,
  LiveModelConnectParams,
  LiveModelEvent,
  LiveModelSession,
  LiveTaskNotification,
  LiveToolCall,
} from "../../../application/live-gateway/ports/realtime-model.port.js";
import {
  buildOpenAITaskNotificationResponse,
  normalizeOpenAIRealtimeEvent,
} from "./openai-realtime.adapter.js";

// The upstream pipeline runs internally at 16 kHz, but its published
// OpenAI-Realtime schema accepts PCM at 24 kHz and resamples at the boundary.
const LOCAL_REALTIME_PCM_SAMPLE_RATE = 24_000;
const LOCAL_SESSION_UPDATE_SETTLE_MS = 100;
const LOCAL_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const LOCAL_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const LOCAL_MAX_QUEUED_RESPONSES = 32;
const LOCAL_MAX_HANDLED_TOOL_CALLS = 4_096;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 4_000;

interface LocalResponseRequest {
  input?: unknown;
  response?: Record<string, unknown>;
}

/**
 * Adapter for Hugging Face speech-to-speech's OpenAI Realtime-compatible
 * server. The wire vocabulary is shared with OpenAI, but the server owns
 * VAD-driven response creation and does not acknowledge session.update.
 */
export class HuggingFaceRealtimeAdapter implements LiveModelAdapter {
  constructor(
    private readonly config: AppConfig["local"],
    private readonly connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    private readonly closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  ) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    const ws = new WebSocket(this.config.url, {
      followRedirects: false,
      handshakeTimeout: this.connectTimeoutMs,
      maxPayload: LOCAL_MAX_EVENT_BYTES,
      perMessageDeflate: false,
    });
    const session = new HuggingFaceRealtimeSession(
      ws,
      this.config,
      params.callbacks,
      this.closeTimeoutMs,
    );

    return await new Promise<LiveModelSession>((resolve, reject) => {
      let settled = false;
      let configured = false;
      let configurationSettle: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        fail(new Error(
          `Hugging Face speech-to-speech did not create a realtime session within ${this.connectTimeoutMs}ms.`,
        ));
      }, this.connectTimeoutMs);
      timeout.unref?.();

      const cleanup = () => {
        clearTimeout(timeout);
        if (configurationSettle) clearTimeout(configurationSettle);
        ws.off("error", fail);
        ws.off("close", onClose);
        ws.off("message", onInitialMessage);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        const failure = error instanceof Error ? error : new Error(errorToMessage(error));
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Local voice session start failed");
        else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        reject(failure);
      };
      const onClose = (code: number, reason: Buffer) => {
        fail(new Error(
          `Hugging Face speech-to-speech closed before session start: ${code} ${reason.toString("utf8")}`,
        ));
      };
      const onInitialMessage = (raw: WebSocket.RawData) => {
        const event = parseLocalEvent(raw);
        if (!event) {
          fail(new Error("Hugging Face speech-to-speech returned invalid JSON during session start."));
          return;
        }
        if (event.type === "error") {
          fail(new Error(localProviderError(event)));
          return;
        }
        if (event.type !== "session.created" || configured) return;
        configured = true;
        try {
          session.configure(params.systemInstruction);
        } catch (error) {
          fail(error);
          return;
        }
        // speech-to-speech intentionally emits no session.updated ack. Keep
        // the startup listeners alive briefly so a schema/configuration error
        // cannot be mistaken for a successful provider smoke test.
        configurationSettle = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          session.markReady();
          params.callbacks.onOpen?.();
          resolve(session);
        }, LOCAL_SESSION_UPDATE_SETTLE_MS);
        configurationSettle.unref?.();
      };

      ws.once("error", fail);
      ws.once("close", onClose);
      ws.on("message", onInitialMessage);
    });
  }
}

class HuggingFaceRealtimeSession implements LiveModelSession {
  private readonly queue: LocalResponseRequest[] = [];
  private readonly handledToolCalls = new Map<string, string>();
  private responsePending = false;
  private responseActive = false;
  private implicitResponsePending = false;
  private inputSpeechActive = false;
  private audioBuffered = false;
  private activeResponseId?: string;
  private closing = false;
  private ready = false;
  private closeOperation?: Promise<void>;

  constructor(
    private readonly ws: WebSocket,
    private readonly config: AppConfig["local"],
    private readonly callbacks: LiveModelCallbacks,
    private readonly closeTimeoutMs: number,
  ) {
    ws.on("message", (raw) => this.handleMessage(raw));
    ws.on("error", (error) => callbacks.onError?.(error));
    ws.on("close", (code, reason) => {
      this.closing = true;
      this.reset();
      callbacks.onClose?.({ code, reason: reason.toString("utf8") });
    });
  }

  configure(systemInstruction: string): void {
    this.sendJson(buildHuggingFaceSessionUpdate(this.config, systemInstruction));
  }

  markReady(): void {
    this.ready = true;
  }

  async sendRealtimeAudio(audio: { data: string; mimeType: string }): Promise<void> {
    const normalized = normalizePcm16Audio(audio, LOCAL_REALTIME_PCM_SAMPLE_RATE);
    this.sendJson({ type: "input_audio_buffer.append", audio: normalized.data });
    this.audioBuffered = true;
  }

  async sendText(text: string): Promise<void> {
    this.schedule({
      input: {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      },
    });
  }

  async sendAudioStreamEnd(): Promise<void> {
    if (!this.audioBuffered) return;
    this.sendJson({ type: "input_audio_buffer.commit" });
    this.audioBuffered = false;
  }

  async cancelResponse(_reason?: string, _truncate?: RealtimeResponseTruncation): Promise<boolean> {
    if (!this.responsePending && !this.responseActive) return false;
    this.sendJson({ type: "response.cancel" });
    return true;
  }

  async sendToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    if (!call.id) throw new Error(`Hugging Face function call ${call.name} did not include a call_id.`);
    this.schedule({
      input: {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.id, output: JSON.stringify(response) },
      },
    });
  }

  async sendTaskNotification(notification: LiveTaskNotification): Promise<void> {
    this.schedule({ response: buildOpenAITaskNotificationResponse(notification) });
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    if (this.closeOperation) return this.closeOperation;
    this.closing = true;
    this.reset();
    this.closeOperation = closeLocalSocket(this.ws, this.closeTimeoutMs);
    return this.closeOperation;
  }

  private handleMessage(raw: WebSocket.RawData): void {
    if (this.closing) return;
    const event = parseLocalEvent(raw);
    if (!event) {
      this.fail(new Error("Hugging Face speech-to-speech returned an invalid realtime event."));
      return;
    }
    if (event.type === "error") {
      this.fail(new Error(localProviderError(event)));
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      this.inputSpeechActive = true;
      this.audioBuffered = false;
    } else if (event.type === "input_audio_buffer.speech_stopped") {
      this.inputSpeechActive = false;
      this.implicitResponsePending = true;
    } else if (event.type === "response.created") {
      const responseId = localResponseId(event);
      if (!responseId) {
        this.fail(new Error("Hugging Face speech-to-speech created a response without an id."));
        return;
      }
      if (this.responseActive && responseId !== this.activeResponseId) {
        this.fail(new Error("Hugging Face speech-to-speech created overlapping responses."));
        return;
      }
      this.responsePending = false;
      this.implicitResponsePending = false;
      this.responseActive = true;
      this.activeResponseId = responseId;
    }

    const normalized = normalizeOpenAIRealtimeEvent(event, "pcm16", {
      provider: "local",
      pcmSampleRate: LOCAL_REALTIME_PCM_SAMPLE_RATE,
      includeCompletedTranscripts: true,
    });
    const toolCalls = normalized.filter(
      (value): value is Extract<LiveModelEvent, { type: "tool_call" }> => value.type === "tool_call",
    );
    if (toolCalls.length > 1) {
      this.fail(new Error("Hugging Face speech-to-speech returned multiple tool calls in one response."));
      return;
    }

    for (const value of normalized) {
      if (value.type === "tool_call") {
        const fingerprint = `${value.call.name}\0${JSON.stringify(value.call.args)}`;
        const key = value.call.id ?? fingerprint;
        const previous = this.handledToolCalls.get(key);
        if (previous && previous !== fingerprint) {
          this.fail(new Error("Hugging Face speech-to-speech reused a tool-call id with different data."));
          return;
        }
        if (previous) continue;
        if (this.handledToolCalls.size >= LOCAL_MAX_HANDLED_TOOL_CALLS) {
          this.fail(new Error(`Local voice exceeded ${LOCAL_MAX_HANDLED_TOOL_CALLS} tool calls in one session.`));
          return;
        }
        this.handledToolCalls.set(key, fingerprint);
      }
      this.callbacks.onEvent(value);
    }

    if (isLocalTerminalResponse(event)) {
      const responseId = localResponseId(event);
      if (this.activeResponseId && responseId && responseId !== this.activeResponseId) return;
      // Upstream emits the cancelled response.done before the matching
      // speech_started event when a user barges in. Keep the response queue
      // blocked across that boundary or a task notification can begin in the
      // tiny gap and talk over the user.
      const interruptedBySpeech = localResponseStatusReason(event) === "turn_detected";
      this.responsePending = false;
      this.responseActive = false;
      this.implicitResponsePending = interruptedBySpeech;
      this.activeResponseId = undefined;
      this.flush();
    }
  }

  private schedule(request: LocalResponseRequest): void {
    if (this.closing) throw new Error("Local voice session is closing.");
    if (this.busy()) {
      if (this.queue.length >= LOCAL_MAX_QUEUED_RESPONSES) {
        throw new Error(`Local voice response queue exceeded ${LOCAL_MAX_QUEUED_RESPONSES} requests.`);
      }
      this.queue.push(request);
      return;
    }
    this.sendRequest(request);
  }

  private flush(): void {
    if (this.closing || this.busy()) return;
    const request = this.queue.shift();
    if (request) this.sendRequest(request);
  }

  private sendRequest(request: LocalResponseRequest): void {
    if (request.input) this.sendJson(request.input);
    this.responsePending = true;
    try {
      this.sendJson({
        type: "response.create",
        ...(request.response ? { response: request.response } : {}),
      });
    } catch (error) {
      this.responsePending = false;
      throw error;
    }
  }

  private busy(): boolean {
    return this.inputSpeechActive || this.implicitResponsePending || this.responsePending || this.responseActive;
  }

  private sendJson(value: unknown): void {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("Local voice WebSocket is not open.");
    const payload = JSON.stringify(value);
    if (this.ws.bufferedAmount + Buffer.byteLength(payload) > LOCAL_MAX_BUFFERED_BYTES) {
      this.ws.terminate();
      throw new Error("Local voice WebSocket exceeded the safe outbound buffer limit.");
    }
    this.ws.send(payload);
  }

  private fail(error: Error): void {
    this.callbacks.onError?.(error);
    if (!this.ready) return;
    this.closing = true;
    this.reset();
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1011, "Local voice provider error");
    else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
  }

  private reset(): void {
    this.responsePending = false;
    this.responseActive = false;
    this.implicitResponsePending = false;
    this.inputSpeechActive = false;
    this.audioBuffered = false;
    this.activeResponseId = undefined;
    this.queue.length = 0;
    this.handledToolCalls.clear();
  }
}

export function buildHuggingFaceSessionUpdate(
  config: AppConfig["local"],
  systemInstruction: string,
): { type: "session.update"; session: Record<string, unknown> } {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: systemInstruction,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: LOCAL_REALTIME_PCM_SAMPLE_RATE },
          turn_detection: {
            type: "server_vad",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: LOCAL_REALTIME_PCM_SAMPLE_RATE },
          voice: config.voice,
        },
      },
      tools: OPENAI_HERMES_LIVE_TOOLS,
      tool_choice: "auto",
    },
  };
}

function parseLocalEvent(raw: WebSocket.RawData): any | undefined {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}

function localProviderError(event: any): string {
  const message = event?.error?.message ?? event?.error ?? event?.message;
  return typeof message === "string" && message.trim()
    ? `Hugging Face speech-to-speech: ${message}`
    : "Hugging Face speech-to-speech returned an error.";
}

function localResponseId(event: any): string | undefined {
  return typeof event?.response?.id === "string"
    ? event.response.id
    : typeof event?.response_id === "string"
      ? event.response_id
      : undefined;
}

function isLocalTerminalResponse(event: any): boolean {
  return event?.type === "response.done"
    || event?.type === "response.cancelled"
    || event?.type === "response.failed"
    || ["completed", "cancelled", "failed", "incomplete"].includes(event?.response?.status);
}

function localResponseStatusReason(event: any): string | undefined {
  const reason = event?.response?.status_details?.reason;
  return typeof reason === "string" ? reason : undefined;
}

function closeLocalSocket(ws: WebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Local voice session did not close within ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();
    ws.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "session closed");
    else ws.terminate();
  });
}
