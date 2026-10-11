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
/** Délai avant de retenter une connexion STT échouée (la session reste vivante). */
const VOXTRAL_STT_RETRY_MS = 3_000;
const VOXTRAL_STT_CONNECT_TIMEOUT_MS = 10_000;
const VOXTRAL_STT_FINAL_TIMEOUT_MS = 12_000;
const VOXTRAL_AUDIO_CHUNK_BYTES = 8_192;
// Server-side turn detection: the chained adapter owns turn-taking, so the
// conversation flows naturally (speak -> pause -> Hermes replies) instead of
// push-to-talk. Thresholds mirror a conversational VAD.
const VOXTRAL_VAD_THRESHOLD_RMS = 0.012;
/**
 * Adaptive floor: quiet phone mics deliver voice around RMS 0.01-0.02 — below
 * the fixed threshold, so the VAD never fired. The floor follows the ambient
 * noise (EMA over silent frames) and anything above floor x factor counts as
 * speech. Keeps working in noisy environments (the floor rises with the noise).
 */
const VOXTRAL_VAD_FLOOR_FACTOR = 2.5;
/** Plancher minimal du bruit : sans borne, l'EMA décroît exponentiellement
 * pendant les silences totaux (micro AEC ≈ 0.0001) jusqu'à ce que TOUT
 * devienne « parole » — le VAD s'arme au premier bruit et ne rend jamais la
 * main : plus aucun tour ne se valide. */
const VOXTRAL_VAD_FLOOR_MIN_RMS = 0.001;
/** Fenêtre pendant laquelle une reconnaissance STT récente compte comme parole. */
const VOXTRAL_STT_SPEECH_WINDOW_MS = 800;
/** Calme soutenu nécessaire avant de remettre le compteur d'onset à zéro. */
const VOXTRAL_ONSET_QUIET_RESET_MS = 300;
const VOXTRAL_VAD_ONSET_MS = 150;
/** Sustained speech required to barge in while the assistant is speaking:
 * a clap, cough or drop is a burst well under this, real speech is above. */
const VOXTRAL_BARGE_ONSET_MS = 450;
const VOXTRAL_VAD_END_OF_TURN_MS = 700;
// Completeness gate: before committing a VAD-detected end of turn, a cheap
// model judges whether the utterance is complete. An incomplete one ("je
// voudrais…") re-arms the VAD and keeps listening instead of being sent to
// Hermes half-spoken.
const VOXTRAL_GATE_MAX_REJECTS = 2;
const VOXTRAL_GATE_TIMEOUT_MS = 4_000;
const VOXTRAL_GATE_HOLD_TIMEOUT_MS = 8_000;

interface VoxtralAdapterConfig {
  apiKey?: string;
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
  language?: string;
  gateEnabled?: boolean;
  gateModel?: string;
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
  private sttFailedAt = 0;
  // Diagnostic : buffer circulaire des dernieres trames recues (dump si aucun STT)
  private frameRing: Buffer[] = [];
  private sttReadyWaiters: Array<() => void> = [];
  private partial = "";
  private pendingFlush: SttPendingFlush | null = null;
  private speechStarted = false;
  private ttsAbort: AbortController | null = null;
  private sawAudioThisTurn = false;
  private lastSpeechAt = 0;
  private speechOnsetAt = 0;
  private silenceSinceAt = 0;
  private vadArmed = false;
  private vadFloor = 0.002;
  private partialActivityAt = 0;
  private lastSttDeltaLog = 0;
  private vadFrames = 0;
  private vadMaxRms = 0;
  private vadLoggedStart = false;
  private turnInFlight = false;
  private gateRejects = 0;
  private gateHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private speakChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: VoxtralAdapterConfig,
    private readonly callbacks: LiveModelCallbacks,
  ) {}

  // ── STT wire ────────────────────────────────────────────────────────────
  private ensureStt(): Promise<void> {
    if (this.stt && (this.stt.readyState === WebSocket.OPEN || this.stt.readyState === WebSocket.CONNECTING)) {
      return this.waitSttReady();
    }
    // Un échec de connexion STT rend la session sourde (le VAD s'arme mais
    // rien n'est transcrit). On réessaie après un délai au lieu d'échouer
    // définitivement.
    if (this.sttFailure && Date.now() - this.sttFailedAt < VOXTRAL_STT_RETRY_MS) {
      return Promise.reject(new Error(this.sttFailure));
    }
    if (this.sttFailure) {
      console.log(`[voxtral-debug] STT retry after failure: ${this.sttFailure}`);
      this.sttFailure = "";
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
      console.log("[voxtral-debug] STT connected");
      this.sttReady = true;
      this.sttReadyWaiters.forEach((fn) => fn());
      this.sttReadyWaiters = [];
    });
    ws.on("error", (error: unknown) => {
      this.sttFailure = `Voxtral realtime connection failed: ${errorToMessage(error)}`;
      this.sttFailedAt = Date.now();
      console.log(`[voxtral-debug] STT FAILED: ${this.sttFailure}`);
      this.sttReadyWaiters.forEach((fn) => fn());
      this.sttReadyWaiters = [];
      this.rejectPendingFlush(new Error(this.sttFailure));
    });
    ws.on("close", () => {
      console.log("[voxtral-debug] STT closed");
      this.rejectPendingFlush(new Error("Voxtral realtime connection closed."));
      if (this.stt === ws) {
        this.stt = null;
        this.sttReady = false;
        // Permet une reconnexion au prochain frame (ensureStt recrée).
      }
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
      this.partialActivityAt = Date.now();
      // Diagnostic (throttlé) : Voxtral entend-il le client ?
      if (Date.now() - this.lastSttDeltaLog > 2_000) {
        this.lastSttDeltaLog = Date.now();
        console.log(`[voxtral-debug] stt delta ${JSON.stringify(this.partial.slice(0, 60))}`);
      }
      this.callbacks.onEvent({ type: "text", text: fragment, speaker: "user", final: false });
    } else if (type === "transcription.done") {
      this.resolvePendingFlush(String(event.text ?? "").trim() || this.partial.trim());
    } else if (type === "error") {
      const err = (event.error ?? {}) as Record<string, unknown>;
      this.sttFailure = `Voxtral realtime error: ${String(err.message ?? err.code ?? "unknown")}`;
      this.sttFailedAt = Date.now();
      console.log(`[voxtral-debug] STT ERROR: ${this.sttFailure}`);
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
    this.frameRing.push(Buffer.from(frame.data, "base64"));
    if (this.frameRing.length > 400) this.frameRing.splice(0, this.frameRing.length - 400);
    this.vadFrame(frame.data);
    try {
      await this.ensureStt();
    } catch (error) {
      this.callbacks.onError?.(error);
      return;
    }
    this.stt!.send(JSON.stringify({ type: "input_audio.append", audio: frame.data }));
  }

  /**
   * Energy VAD on the incoming 16 kHz PCM: speech events fire on actual voice
   * (so the client's barge-in interrupt only triggers when the user really
   * speaks over the assistant), and a sustained silence after speech ends the
   * turn automatically — the "speak naturally" conversation flow. Push to
   * talk keeps working: audio.end flushes whatever utterance is in progress.
   */
  private vadFrame(base64Pcm: string): void {
    // Diagnostic : première trame + statistiques périodiques (niveau micro tel
    // que reçu par la gateway) — voir les logs si un client n'obtient pas de réponse.
    if (!this.vadLoggedStart) {
      this.vadLoggedStart = true;
      console.log("[voxtral-debug] audio stream started");
    }
    this.vadFrames++;
    const now = Date.now();
    const level = pcm16RmsBase64(base64Pcm);
    if (level > this.vadMaxRms) this.vadMaxRms = level;
    if (this.vadFrames % 200 === 0) {
      console.log(
        `[voxtral-debug] frames=${this.vadFrames} maxRms=${this.vadMaxRms.toFixed(4)} lastRms=${level.toFixed(4)} floor=${this.vadFloor.toFixed(4)}`,
      );
      this.vadMaxRms = 0;
    }
    const onsetMs = this.ttsAbort ? VOXTRAL_BARGE_ONSET_MS : VOXTRAL_VAD_ONSET_MS;
    const speechy = level >= VOXTRAL_VAD_THRESHOLD_RMS || level >= this.vadFloor * VOXTRAL_VAD_FLOOR_FACTOR;
    if (speechy) {
      this.lastSpeechAt = now;
      this.silenceSinceAt = 0;
    } else {
      // STT-driven speech: a distant voice in ambient noise (phone on a car
      // seat, road rumble) can sit AT the noise floor by energy — invisible to
      // the energy VAD — while Voxtral still recognizes the words. If the STT
      // produced text recently, it IS speech. Skipped while TTS is in flight
      // so the assistant's own echo cannot re-arm the turn.
      if (!this.ttsAbort && now - this.partialActivityAt < VOXTRAL_STT_SPEECH_WINDOW_MS) {
        this.lastSpeechAt = now;
        this.silenceSinceAt = 0;
      } else {
        if (!this.silenceSinceAt) this.silenceSinceAt = now;
        // Onset tolérant : la vraie parole fluctue — une frame calme isolée ne
        // remet PAS le compteur d'onset à zéro ; seul un calme soutenu (300 ms).
        if (now - this.silenceSinceAt >= VOXTRAL_ONSET_QUIET_RESET_MS) this.speechOnsetAt = 0;
        // Silence: track the noise floor (EMA, bornée basse) and end the turn after a lull.
        this.vadFloor = Math.max(VOXTRAL_VAD_FLOOR_MIN_RMS, 0.97 * this.vadFloor + 0.03 * level);
        if (this.vadArmed && now - this.lastSpeechAt >= VOXTRAL_VAD_END_OF_TURN_MS && !this.turnInFlight) {
          this.vadArmed = false;
          console.log(`[voxtral-debug] end of turn (partial=${JSON.stringify(this.partial.slice(0, 80))})`);
          void this.endTurnAutomatically();
        }
        return;
      }
    }
    if (!this.speechStarted) {
      if (!this.speechOnsetAt) this.speechOnsetAt = now;
      if (now - this.speechOnsetAt >= onsetMs) {
        this.speechStarted = true;
        this.speechOnsetAt = 0;
        this.vadArmed = true;
        this.gateRejects = 0;
        this.clearGateHoldTimer();
        console.log(`[voxtral-debug] VAD armed level=${level.toFixed(4)} floor=${this.vadFloor.toFixed(4)}`);
        this.callbacks.onEvent({ type: "input_speech_started", provider: "voxtral" });
      }
    }
  }

  private async endTurnAutomatically(): Promise<void> {
    if (this.closing || this.turnInFlight) return;
    if (this.config.gateEnabled) {
      const transcript = this.partial.trim();
      if (transcript && this.gateRejects < VOXTRAL_GATE_MAX_REJECTS) {
        let complete = true;
        try {
          complete = await this.gateJudge(transcript);
        } catch {
          complete = true; // a gate failure must never block the conversation
        }
        if (!complete) {
          this.gateRejects += 1;
          // Hold the turn: only NEW speech re-arms the end-of-turn check
          // (silence frames must not re-trigger the gate 150ms later, which
          // would burn the rejection budget and commit anyway). Close the
          // speech segment so the next utterance re-arms the VAD (and a new
          // input_speech_started fires for the client's barge-in). The
          // utterance keeps growing on the same realtime stream.
          this.speechStarted = false;
          this.vadArmed = false;
          // Safety net: a held turn commits anyway when nothing follows, so
          // a wrong NO can never leave the user without an answer.
          this.armGateHoldTimer();
          return;
        }
      }
    }
    this.gateRejects = 0;
    try {
      await this.commitTurn();
    } catch {
      // a failed auto-commit must not kill the session; the user can retry
    }
  }

  private armGateHoldTimer(): void {
    this.clearGateHoldTimer();
    this.gateHoldTimer = setTimeout(() => {
      this.gateHoldTimer = null;
      if (this.closing || this.turnInFlight) return;
      if (!this.partial.trim()) return;
      this.gateRejects = 0;
      void this.commitTurn();
    }, VOXTRAL_GATE_HOLD_TIMEOUT_MS);
  }

  private clearGateHoldTimer(): void {
    if (this.gateHoldTimer) {
      clearTimeout(this.gateHoldTimer);
      this.gateHoldTimer = null;
    }
  }

  /** Cheap completeness judge: "YES"/"NO" from a small chat model. */
  private async gateJudge(transcript: string): Promise<boolean> {
    const base = this.config.baseUrl.replace(/\/$/u, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VOXTRAL_GATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.gateModel || "mistral-small-latest",
          messages: [
            {
              role: "system",
              content:
                "You judge spoken-voice turn boundaries from a LIVE transcript " +
                "(its start may be missing punctuation; ignore odd capitalization " +
                "and commas mid-sentence). Default to YES. Answer NO only when " +
                "the utterance ENDS mid-phrase — the very last words are a " +
                "dangling conjunction, article, subordinator or an unfinished " +
                "clause (e.g. 'je voudrais…', 'avec la…'). A sentence that ends " +
                "on a normal word is YES. Answer YES or NO only.",
            },
            { role: "user", content: transcript.slice(-500) },
          ],
          max_tokens: 4,
          temperature: 0,
        }),
      });
      if (!response.ok) return true;
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const answer = String(payload.choices?.[0]?.message?.content ?? "yes")
        .trim()
        .toLowerCase();
      return !answer.startsWith("no");
    } finally {
      clearTimeout(timer);
    }
  }

  async sendAudioStreamEnd(): Promise<boolean> {
    if (this.closing) return false;
    if (!this.sawAudioThisTurn) return false;
    const dispatched = await this.commitTurn();
    if (dispatched) this.sawAudioThisTurn = false;
    return dispatched;
  }

  private async commitTurn(): Promise<boolean> {
    this.clearGateHoldTimer();
    if (this.closing || this.turnInFlight) return false;
    this.turnInFlight = true;
    try {
      return await this.commitTurnInner();
    } finally {
      this.turnInFlight = false;
    }
  }

  private async commitTurnInner(): Promise<boolean> {
    this.speechStarted = false;
    this.callbacks.onEvent({ type: "input_speech_stopped", provider: "voxtral" });
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
    // Accept the receipt IMMEDIATELY: the gateway bounds provider IO waits
    // (10s), and a TTS synthesis must never be what kills the session. The
    // speech (and its response.completed) flows as events when ready.
    this.speakChain = this.speakChain.then(() => this.speakTurn(spoken));
  }

  private async speakTurn(text: string): Promise<void> {
    if (this.closing) return;
    await this.speak(text);
    this.callbacks.onEvent({ type: "response", status: "completed" });
  }

  async sendTaskNotification(notification: LiveTaskNotification): Promise<void> {
    const { announcement } = requireLiveTaskNotification(notification);
    this.callbacks.onEvent({ type: "response", status: "started" });
    this.speakChain = this.speakChain.then(() => this.speakTurn(announcement));
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
    console.log(`[voxtral-debug] session closed frames=${this.vadFrames}`);
    if (this.vadFrames > 50 && this.partialActivityAt === 0 && this.frameRing.length > 0) {
      try {
        const dumpPath = `/tmp/live-capture-${Date.now()}.pcm`;
        require("node:fs").writeFileSync(dumpPath, Buffer.concat(this.frameRing));
        console.log(`[voxtral-debug] no-STT session dumped to ${dumpPath} (${this.frameRing.length} frames)`);
      } catch {
        // dump best-effort
      }
    }
    this.frameRing = [];
    this.clearGateHoldTimer();
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
    // The transcript keeps the full text; only the SPOKEN audio is sanitized
    // (code blocks, file paths, URLs and long identifiers are summarized) so a
    // voice reply never reads out "slash home slash flo slash …".
    const spoken = voxtralSpeechFriendly(clean);
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
          input: spoken,
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

function pcm16RmsBase64(base64Pcm: string): number {
  const buf = Buffer.from(base64Pcm, "base64");
  const count = buf.length >> 1;
  if (!count) return 0;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const v = buf.readInt16LE(i * 2);
    acc += v * v;
  }
  return Math.sqrt(acc / count) / 32_768;
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

/**
 * Speech-friendly rendering of an assistant reply for TTS. The full text stays
 * available in the transcript; this only shapes what is SPOKEN. Code blocks,
 * URLs, file paths and long technical identifiers are replaced by short
 * natural-language summaries so the voice channel stays conversational.
 */
export function voxtralSpeechFriendly(text: string): string {
  const spoken = text
    .replace(/```[\s\S]*?```/gu, " (bloc de code) ")
    .replace(/`([^`\n]+)`/gu, (_match, code: string) =>
      code.trim().split(/\s+/u).length <= 3 ? ` ${code.trim()} ` : " (extrait de code) ",
    )
    .replace(/https?:\/\/\S+/gu, " (lien) ")
    .replace(/(?:~\/)?\/?(?:[A-Za-z0-9_.+-]+\/){2,}[A-Za-z0-9_.+-]*/gu, " (chemin de fichiers) ")
    .replace(/\b[A-Za-z0-9_.\/+-]{30,}\b/gu, " (identifiant technique) ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return spoken || text.trim();
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
