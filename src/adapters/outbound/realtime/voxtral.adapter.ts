import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { normalizePcm16Audio } from "../../../domain/audio/pcm.js";
import {
  requireLiveTaskNotification,
  type LiveModelAdapter,
  type LiveModelAudio,
  type LiveModelCallbacks,
  type LiveModelConnectParams,
  type LiveModelSession,
  type LiveTaskNotification,
  type LiveToolCall,
} from "../../../application/live-gateway/ports/realtime-model.port.js";
import { errorToMessage } from "../../../domain/error-message.js";

/**
 * Voxtral (Mistral) live adapter — chained, no speech-to-speech model.
 *
 * STT: the Voxtral Realtime WebSocket
 * (wss://api.mistral.ai/v1/audio/transcriptions/realtime) receives PCM16
 * frames and streams partial transcripts; `input_audio.flush` commits the
 * utterance into one final transcript.
 *
 * Policy: deterministic — every committed user turn becomes exactly one
 * `continue_hermes_conversation` tool call, so Hermes owns memory, tools and
 * history. There is no local turn-routing model (that is the point: no
 * third voice model between the user and Hermes).
 *
 * TTS: POST /v1/audio/speech (Voxtral TTS) returns JSON {audio_data: base64
 * WAV}; the PCM payload is re-emitted as audio/pcm;rate=24000 events.
 */

const VOXTRAL_STT_INPUT_RATE = 16_000;
const VOXTRAL_TTS_OUTPUT_RATE = 24_000;
const VOXTRAL_STT_CONNECT_TIMEOUT_MS = 10_000;
const VOXTRAL_STT_FINAL_TIMEOUT_MS = 12_000;
const VOXTRAL_AUDIO_CHUNK_BYTES = 8_192;

interface VoxtralAdapterConfig {
  apiKey?: string;
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
  language?: string;
}

export class VoxtralLiveAdapter implements LiveModelAdapter {
  constructor(
    private readonly config: VoxtralAdapterConfig,
    _providerReadyTimeoutMs: number,
  ) {
    if (!config.apiKey) {
      throw new Error("Voxtral live adapter requires a Mistral API key (VOXTRAL_API_KEY or MISTRAL_API_KEY).");
    }
  }

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    queueMicrotask(() => params.callbacks.onOpen?.());
    return new VoxtralLiveSession(this.config, params.callbacks);
  }
}

interface SttPendingFlush {
  resolve: (transcript: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class VoxtralLiveSession implements LiveModelSession {
  private closing = false;
  private stt: WebSocket | null = null;
  private sttReady = false;
  private sttFailure = "";
  private sttReadyWaiters: Array<() => void> = [];
  private partial = "";
  private pendingFlush: SttPendingFlush | null = null;
  private speechStarted = false;
  private ttsAbort: AbortController | null = null;
  private sawAudioThisTurn = false;

  constructor(
    private readonly config: VoxtralAdapterConfig,
    private readonly callbacks: LiveModelCallbacks,
  ) {}

  // ── STT wire ────────────────────────────────────────────────────────────
  private ensureStt(): Promise<void> {
    if (this.stt && (this.stt.readyState === WebSocket.OPEN || this.stt.readyState === WebSocket.CONNECTING)) {
      return this.waitSttReady();
    }
    if (this.closing || this.sttFailure) {
      return Promise.reject(new Error(this.sttFailure || "session closed"));
    }
    const apiKey = this.config.apiKey!;
    const base = this.config.baseUrl.replace(/^https:/u, "wss:").replace(/\/$/u, "");
    const url = `${base}/v1/audio/transcriptions/realtime?model=${encodeURIComponent(this.config.sttModel)}`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      handshakeTimeout: VOXTRAL_STT_CONNECT_TIMEOUT_MS,
    });
    this.stt = ws;
    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      this.handleSttMessage(String(raw));
    });
    ws.on("open", () => {
      this.sttReady = true;
      this.sttReadyWaiters.forEach((fn) => fn());
      this.sttReadyWaiters = [];
    });
    ws.on("error", (error: unknown) => {
      this.sttFailure = `Voxtral realtime connection failed: ${errorToMessage(error)}`;
      this.sttReadyWaiters.forEach((fn) => fn());
      this.sttReadyWaiters = [];
      this.rejectPendingFlush(new Error(this.sttFailure));
    });
    ws.on("close", () => {
      this.rejectPendingFlush(new Error("Voxtral realtime connection closed."));
      if (this.stt === ws) this.stt = null;
    });
    return this.waitSttReady();
  }

  private waitSttReady(): Promise<void> {
    if (this.sttReady) return Promise.resolve();
    if (this.sttFailure) return Promise.reject(new Error(this.sttFailure));
    return new Promise((resolve) => this.sttReadyWaiters.push(resolve));
  }

  private handleSttMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const event = parsed as Record<string, unknown>;
    const type = event.type;
    if (type === "transcription.text.delta") {
      const fragment = String(event.text ?? "");
      this.partial += fragment;
      this.callbacks.onEvent({ type: "text", text: fragment, speaker: "user", final: false });
    } else if (type === "transcription.done") {
      this.resolvePendingFlush(String(event.text ?? "").trim() || this.partial.trim());
    } else if (type === "error") {
      const err = (event.error ?? {}) as Record<string, unknown>;
      this.sttFailure = `Voxtral realtime error: ${String(err.message ?? err.code ?? "unknown")}`;
      this.rejectPendingFlush(new Error(this.sttFailure));
    }
    // session.created / session.updated / transcription.language: ignored.
  }

  private resolvePendingFlush(transcript: string): void {
    const pending = this.pendingFlush;
    this.pendingFlush = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(transcript);
    }
  }

  private rejectPendingFlush(error: Error): void {
    const pending = this.pendingFlush;
    this.pendingFlush = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  // ── LiveModelSession ─────────────────────────────────────────────────────
  async sendRealtimeAudio(audio: LiveModelAudio): Promise<void> {
    if (this.closing) return;
    const frame = normalizePcm16Audio(
      { data: audio.data, mimeType: audio.mimeType },
      VOXTRAL_STT_INPUT_RATE,
    );
    this.sawAudioThisTurn = true;
    if (!this.speechStarted) {
      this.speechStarted = true;
      this.callbacks.onEvent({ type: "input_speech_started", provider: "voxtral" });
    }
    try {
      await this.ensureStt();
    } catch (error) {
      this.callbacks.onError?.(error);
      return;
    }
    this.stt!.send(JSON.stringify({ type: "input_audio.append", audio: frame.data }));
  }

  async sendAudioStreamEnd(): Promise<boolean> {
    if (this.closing) return false;
    if (!this.sawAudioThisTurn) return false;
    this.sawAudioThisTurn = false;
    if (this.speechStarted) {
      this.speechStarted = false;
      this.callbacks.onEvent({ type: "input_speech_stopped", provider: "voxtral" });
    }
    const ws = this.stt;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // No live wire: fall back to whatever partials accumulated.
      return this.dispatchConversationTurn(this.partial.trim());
    }
    ws.send(JSON.stringify({ type: "input_audio.flush" }));
    let transcript: string;
    try {
      transcript = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingFlush = null;
          resolve(this.partial.trim());
        }, VOXTRAL_STT_FINAL_TIMEOUT_MS);
        this.pendingFlush = { resolve, reject, timer };
      });
    } catch {
      return this.dispatchConversationTurn(this.finalizeUserEntry(this.partial.trim()));
    }
    return this.dispatchConversationTurn(this.finalizeUserEntry(transcript.trim()));
  }

  /**
   * transcript.delta fragments are APPENDED client-side; the live user entry
   * settles when a final text event arrives. Emit only the correction — the
   * difference between the final transcript and what was already displayed —
   * so the completed entry is neither duplicated nor garbled. A single space
   * settles the entry when the fragments already cover the final transcript.
   */
  private finalizeUserEntry(transcript: string): string {
    const displayed = this.partial;
    let correction = transcript.startsWith(displayed) ? transcript.slice(displayed.length) : "";
    if (correction.length === 0) correction = " ";
    this.partial = "";
    this.callbacks.onEvent({ type: "text", text: correction, speaker: "user", final: true });
    return transcript;
  }

  private dispatchConversationTurn(transcript: string): boolean {
    if (!transcript || this.closing) return false;
    this.callbacks.onEvent({ type: "response", status: "started" });
    this.callbacks.onEvent({
      type: "tool_call",
      call: {
        id: `voxtral_${randomUUID()}`,
        name: "continue_hermes_conversation",
        args: { message: transcript },
      },
    });
    return true;
  }

  async sendText(text: string): Promise<void> {
    if (this.closing || !text.trim()) return;
    this.dispatchConversationTurn(text.trim());
  }

  async sendToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    if (this.closing) return;
    const spoken = voxtralSpokenToolText(call, response);
    await this.speak(spoken);
    this.callbacks.onEvent({ type: "response", status: "completed" });
  }

  async sendTaskNotification(notification: LiveTaskNotification): Promise<void> {
    const { announcement } = requireLiveTaskNotification(notification);
    this.callbacks.onEvent({ type: "response", status: "started" });
    await this.speak(announcement);
    this.callbacks.onEvent({ type: "response", status: "completed" });
  }

  async cancelResponse(): Promise<boolean> {
    if (this.ttsAbort) {
      this.ttsAbort.abort();
      this.ttsAbort = null;
      this.callbacks.onEvent({ type: "response", status: "cancelled" });
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.ttsAbort?.abort();
    this.ttsAbort = null;
    this.rejectPendingFlush(new Error("session closed"));
    const ws = this.stt;
    this.stt = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        ws.once("close", () => { clearTimeout(timer); resolve(); });
        try { ws.close(1000, "session closed"); } catch { clearTimeout(timer); resolve(); }
      });
    }
  }

  // ── TTS ──────────────────────────────────────────────────────────────────
  private async speak(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean || this.closing) return;
    this.callbacks.onEvent({ type: "text", text: clean, speaker: "assistant", final: true });
    const abort = new AbortController();
    this.ttsAbort = abort;
    try {
      const base = this.config.baseUrl.replace(/\/$/u, "");
      const response = await fetch(`${base}/v1/audio/speech`, {
        method: "POST",
        signal: abort.signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.ttsModel,
          voice: this.config.voice,
          input: clean,
          response_format: "wav",
        }),
      });
      if (!response.ok) {
        this.callbacks.onError?.(new Error(`Voxtral TTS failed with HTTP ${response.status}`));
        return;
      }
      const payload = (await response.json()) as { audio_data?: string };
      const pcm = extractWavPcmBase64(payload.audio_data ?? "");
      if (!pcm) {
        this.callbacks.onError?.(new Error("Voxtral TTS returned no audio data."));
        return;
      }
      const raw = Buffer.from(pcm, "base64");
      for (let offset = 0; offset < raw.length && !this.closing; offset += VOXTRAL_AUDIO_CHUNK_BYTES) {
        if (abort.signal.aborted) return;
        const chunk = raw.subarray(offset, Math.min(offset + VOXTRAL_AUDIO_CHUNK_BYTES, raw.length));
        this.callbacks.onEvent({
          type: "audio",
          audio: {
            data: chunk.toString("base64"),
            mimeType: `audio/pcm;rate=${VOXTRAL_TTS_OUTPUT_RATE}`,
          },
        });
      }
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") {
        this.callbacks.onError?.(error);
      }
    } finally {
      if (this.ttsAbort === abort) this.ttsAbort = null;
    }
  }
}

function voxtralSpokenToolText(call: LiveToolCall, response: Record<string, unknown>): string {
  if (response.ok === false) {
    const error = typeof response.error === "string" ? response.error : "";
    return error || "Hermes could not complete that request.";
  }
  if (call.name === "continue_hermes_conversation") {
    const message = typeof response.message === "string" ? response.message : "";
    return message || "Done.";
  }
  if (typeof response.message === "string" && response.message) return response.message;
  if (typeof response.output === "string" && response.output) return response.output;
  if (call.name === "start_background_task") return "Task started. I will tell you when it is done.";
  if (call.name === "stop_background_task") return "Task stopped.";
  return "Done.";
}

/** Minimal RIFF/WAVE reader: returns the data chunk payload as base64 PCM16. */
export function extractWavPcmBase64(wavBase64: string): string | null {
  if (!wavBase64) return null;
  const buf = Buffer.from(wavBase64, "base64");
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      const start = offset + 8;
      const end = Math.min(start + chunkSize, buf.length);
      if (end <= start) return null;
      return buf.subarray(start, end).toString("base64");
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}
