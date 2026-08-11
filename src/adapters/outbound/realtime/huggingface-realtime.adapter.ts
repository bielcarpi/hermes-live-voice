import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { normalizePcm16Audio } from "../../../domain/audio/pcm.js";
import { errorToMessage } from "../../../domain/error-message.js";
import type { RealtimeResponseTruncation } from "../../../domain/protocol/client-protocol.js";
import type { AppConfig } from "../../../config.js";
import { selectCompactOpenAIHermesLiveTools } from "../../../application/live-gateway/tool-definitions.js";
import type {
  LiveModelAdapter,
  LiveModelCallbacks,
  LiveModelConnectParams,
  LiveModelEvent,
  LiveModelSession,
  LiveTaskNotification,
  LiveToolCall,
  LiveToolName,
} from "../../../application/live-gateway/ports/realtime-model.port.js";
import {
  buildLocalConversationResponse,
  buildLocalExactSpeechResponse,
  buildLocalTaskQuestionResponse,
  isClearLocalWorkRequest,
  localRoutedAction,
  matchLocalStoppableTask,
  selectLocalFinishedTask,
  selectLocalStoppableTasks,
  selectLocalTaskForQuestion,
  type LocalRoutedAction,
} from "./huggingface-local-routing.js";
import {
  buildOpenAITaskNotificationResponse,
  normalizeOpenAIRealtimeEvent,
} from "./openai-realtime.adapter.js";

// The upstream pipeline runs internally at 16 kHz, but its published
// OpenAI-Realtime schema accepts PCM at 24 kHz and resamples at the boundary.
const LOCAL_REALTIME_PCM_SAMPLE_RATE = 24_000;
const LOCAL_TURN_END_SILENCE_MS = 1_000;
const LOCAL_TURN_END_SILENCE = Buffer.alloc(
  LOCAL_REALTIME_PCM_SAMPLE_RATE * 2 * LOCAL_TURN_END_SILENCE_MS / 1_000,
).toString("base64");
const LOCAL_SESSION_UPDATE_SETTLE_MS = 100;
const LOCAL_BUSY_RETRY_MS = 500;
const LOCAL_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const LOCAL_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const LOCAL_MAX_QUEUED_RESPONSES = 32;
const LOCAL_MAX_HANDLED_TOOL_CALLS = 4_096;
const LOCAL_MAX_BUFFERED_ASSISTANT_TEXT_EVENTS = 256;
const LOCAL_MAX_BUFFERED_ASSISTANT_TEXT_CHARS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 4_000;
export const DEFAULT_LOCAL_RESPONSE_TIMEOUT_MS = 120_000;
export const DEFAULT_LOCAL_PIPELINE_RELEASE_GRACE_MS = 150;

interface LocalResponseRequest {
  input?: unknown;
  response?: Record<string, unknown>;
  kind?: "conversation" | "task_notification";
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
    private readonly responseTimeoutMs = DEFAULT_LOCAL_RESPONSE_TIMEOUT_MS,
    private readonly pipelineReleaseGraceMs = DEFAULT_LOCAL_PIPELINE_RELEASE_GRACE_MS,
  ) {}

  async connect(params: LiveModelConnectParams): Promise<LiveModelSession> {
    const deadline = Date.now() + this.connectTimeoutMs;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Hugging Face speech-to-speech stayed busy for ${this.connectTimeoutMs}ms.`,
        );
      }
      try {
        return await this.connectOnce(params, remainingMs);
      } catch (error) {
        if (
          !this.config.ownsTurnRouting
          || !isLocalPipelineBusyError(error)
          || deadline - Date.now() <= LOCAL_BUSY_RETRY_MS
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, LOCAL_BUSY_RETRY_MS));
      }
    }
  }

  private async connectOnce(
    params: LiveModelConnectParams,
    timeoutMs: number,
  ): Promise<LiveModelSession> {
    const ws = new WebSocket(this.config.url, {
      followRedirects: false,
      handshakeTimeout: timeoutMs,
      maxPayload: LOCAL_MAX_EVENT_BYTES,
      perMessageDeflate: false,
    });
    const session = new HuggingFaceRealtimeSession(
      ws,
      this.config,
      params.callbacks,
      this.closeTimeoutMs,
      this.responseTimeoutMs,
      this.pipelineReleaseGraceMs,
    );

    return await new Promise<LiveModelSession>((resolve, reject) => {
      let settled = false;
      let configured = false;
      let configurationSettle: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        fail(new Error(
          `Hugging Face speech-to-speech did not create a realtime session within ${timeoutMs}ms.`,
        ));
      }, timeoutMs);
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
          session.configure(params.systemInstruction, params.availableTools);
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
  private readonly syntheticToolCalls = new Map<string, LocalRoutedAction>();
  private availableTools?: ReadonlySet<LiveToolName>;
  private responsePending = false;
  private responseActive = false;
  private implicitResponsePending = false;
  private inputSpeechActive = false;
  private pendingCompletedVoiceTranscript?: string;
  private referencedTaskId?: string;
  private audioBuffered = false;
  private activeResponseId?: string;
  private pendingResponseKind?: "conversation" | "task_notification";
  private activeResponseKind?: "conversation" | "task_notification";
  private responseProducedOutput = false;
  private responseProducedToolCall = false;
  private readonly bufferedAssistantText: Extract<LiveModelEvent, { type: "text" }>[] = [];
  private bufferedAssistantTextChars = 0;
  private responseTimeout?: ReturnType<typeof setTimeout>;
  private providerClosedAt?: number;
  private closing = false;
  private ready = false;
  private closeOperation?: Promise<void>;

  constructor(
    private readonly ws: WebSocket,
    private readonly config: AppConfig["local"],
    private readonly callbacks: LiveModelCallbacks,
    private readonly closeTimeoutMs: number,
    private readonly responseTimeoutMs: number,
    private readonly pipelineReleaseGraceMs: number,
  ) {
    ws.on("message", (raw) => this.handleMessage(raw));
    ws.on("error", (error) => callbacks.onError?.(error));
    ws.on("close", (code, reason) => {
      this.providerClosedAt = Date.now();
      this.closing = true;
      this.reset();
      if (this.ready) callbacks.onClose?.({ code, reason: reason.toString("utf8") });
    });
  }

  configure(
    systemInstruction: string,
    availableTools?: LiveModelConnectParams["availableTools"],
  ): void {
    this.availableTools = availableTools ? new Set(availableTools) : undefined;
    this.sendJson(buildHuggingFaceSessionUpdate(this.config, systemInstruction, availableTools));
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
    const action = this.config.ownsTurnRouting ? this.routedAction(text) : undefined;
    if (action) {
      this.sendJson({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      });
      this.emitSyntheticToolCall(action);
      return;
    }
    this.schedule({
      input: {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      },
    });
  }

  async sendAudioStreamEnd(): Promise<boolean> {
    if (!this.audioBuffered) return false;
    // The upstream realtime server owns turn finalization through VAD and
    // currently rejects OpenAI's input_audio_buffer.commit event. A bounded
    // tail of PCM silence closes a push-to-talk turn through the same path as
    // natural microphone silence without creating a second transport mode.
    this.sendJson({ type: "input_audio_buffer.append", audio: LOCAL_TURN_END_SILENCE });
    this.audioBuffered = false;
    return true;
  }

  async cancelResponse(_reason?: string, _truncate?: RealtimeResponseTruncation): Promise<boolean> {
    if (!this.responsePending && !this.responseActive) return false;
    this.sendJson({ type: "response.cancel" });
    return true;
  }

  async sendToolResponse(call: LiveToolCall, response: Record<string, unknown>): Promise<void> {
    if (!call.id) throw new Error(`Hugging Face function call ${call.name} did not include a call_id.`);
    const spokenReceipt = localSpokenToolReceipt(response);
    const returnedTaskId = localReturnedTaskId(response);
    if (returnedTaskId) this.referencedTaskId = returnedTaskId;
    const routedAction = this.syntheticToolCalls.get(call.id);
    if (routedAction) {
      this.syntheticToolCalls.delete(call.id);
      if (spokenReceipt) {
        this.schedule({
          kind: "conversation",
          response: {
            conversation: "none",
            instructions: `Say exactly this one short tool receipt and nothing else: ${JSON.stringify(spokenReceipt)}`,
            output_modalities: ["audio"],
            tools: [],
            tool_choice: "none",
            metadata: {
              hermes_live_purpose: "tool_receipt",
              hermes_live_exact_speech: spokenReceipt,
            },
          },
        });
      } else if (routedAction.taskQuestion) {
        this.referencedTaskId = selectLocalTaskForQuestion(routedAction.taskQuestion, response);
        this.schedule({
          kind: "conversation",
          response: buildLocalTaskQuestionResponse(routedAction.taskQuestion, response),
        });
      } else if (routedAction.taskControl?.type === "stop") {
        const stoppable = selectLocalStoppableTasks(response);
        if (stoppable.length === 0) {
          this.schedule({
            kind: "conversation",
            response: buildLocalExactSpeechResponse("There isn't an active background task to stop."),
          });
        } else if (routedAction.taskControl.selection === "matching") {
          const match = matchLocalStoppableTask(response, routedAction.taskControl.query);
          if (match.status === "matched") {
            this.referencedTaskId = match.taskId;
            this.emitSyntheticToolCall({
              name: "stop_background_task",
              args: { task_id: match.taskId },
            });
          } else {
            this.schedule({
              kind: "conversation",
              response: buildLocalExactSpeechResponse(
                match.status === "ambiguous"
                  ? `I found ${match.count} matching active tasks. Open the task inbox or say stop the latest task.`
                  : "I couldn't match that to an active task. Open the task inbox or say stop the latest task.",
              ),
            });
          }
        } else if (routedAction.taskControl.selection === "single" && stoppable.length > 1) {
          this.schedule({
            kind: "conversation",
            response: buildLocalExactSpeechResponse(
              `You have ${stoppable.length} active tasks. Say which one you want me to stop.`,
            ),
          });
        } else {
          this.referencedTaskId = stoppable[0];
          this.emitSyntheticToolCall({
            name: "stop_background_task",
            args: { task_id: stoppable[0] },
          });
        }
      } else if (routedAction.taskControl?.type === "follow_up") {
        const parentTaskId = selectLocalFinishedTask(response);
        if (!parentTaskId) {
          this.schedule({
            kind: "conversation",
            response: buildLocalExactSpeechResponse(
              "I couldn't find a finished background task to follow up.",
            ),
          });
        } else {
          const followUp: LocalRoutedAction = {
            name: "follow_up_background_task",
            args: { task_id: parentTaskId, message: routedAction.taskControl.message },
          };
          if (this.canRouteAction(followUp)) {
            this.emitSyntheticToolCall(followUp);
          } else {
            this.schedule({
              kind: "conversation",
              response: buildLocalExactSpeechResponse(
                "This Hermes version can't start task follow-ups.",
              ),
            });
          }
        }
      } else if (routedAction.name === "continue_hermes_conversation") {
        this.schedule({
          kind: "conversation",
          response: buildLocalConversationResponse(response),
        });
      } else {
        this.fail(new Error(`Managed local action ${routedAction.name} returned no spoken response.`));
      }
      return;
    }
    this.schedule({
      kind: "conversation",
      input: {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.id, output: JSON.stringify(response) },
      },
      ...(spokenReceipt
        ? {
            response: {
              instructions: `Say exactly this one short tool receipt and nothing else: ${JSON.stringify(spokenReceipt)}`,
              output_modalities: ["audio"],
              tools: [],
              tool_choice: "none",
              metadata: {
                hermes_live_purpose: "tool_receipt",
                hermes_live_exact_speech: spokenReceipt,
              },
            },
          }
        : {}),
    });
  }

  async sendTaskNotification(notification: LiveTaskNotification): Promise<void> {
    const response = buildOpenAITaskNotificationResponse(notification);
    response.metadata = {
      hermes_live_purpose: "task_notification",
      hermes_live_exact_speech: notification.announcement,
    };
    this.schedule({ kind: "task_notification", response });
  }

  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    if (this.ws.readyState === WebSocket.CLOSED) {
      this.closeOperation = waitForLocalPipelineRelease(
        this.providerClosedAt ?? Date.now(),
        this.pipelineReleaseGraceMs,
      );
      return this.closeOperation;
    }
    this.closing = true;
    this.reset();
    this.closeOperation = closeLocalSocket(
      this.ws,
      this.closeTimeoutMs,
      this.pipelineReleaseGraceMs,
    );
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
      this.pendingCompletedVoiceTranscript = undefined;
    } else if (event.type === "input_audio_buffer.speech_stopped") {
      this.inputSpeechActive = false;
      this.implicitResponsePending = true;
      this.audioBuffered = false;
      this.armResponseTimeout();
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
      this.activeResponseKind = this.pendingResponseKind ?? "conversation";
      this.pendingResponseKind = undefined;
      this.responseProducedOutput = false;
      this.clearBufferedResponseOutput();
      this.armResponseTimeout();
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

    const terminal = isLocalTerminalResponse(event);
    const completedWithoutOutput = terminal
      && localResponseStatus(event) === "completed"
      && !this.responseProducedOutput
      && !normalized.some(isUsableLocalResponseOutput);
    const deliverable: LiveModelEvent[] = [];
    for (const original of normalized) {
      const scoped = original.type === "response" && this.activeResponseKind
        ? { ...original, scope: this.activeResponseKind }
        : original;
      const value = completedWithoutOutput && scoped.type === "response" && scoped.status === "completed"
        ? {
            ...scoped,
            status: "failed" as const,
            error: "The local voice model returned no usable reply. Try again or switch voice provider.",
          }
        : scoped;
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
        // Some compact local models emit an assistant answer and a structured
        // tool call in the same response. The action is authoritative: do not
        // let speculative text or later TTS contradict the deterministic tool
        // receipt returned by the gateway.
        this.responseProducedToolCall = true;
        this.dropBufferedAssistantText();
      }
      if (isUsableLocalResponseOutput(value)) this.responseProducedOutput = true;
      if (isAssistantText(value)) {
        if (!this.responseProducedToolCall && !this.bufferAssistantText(value)) return;
        continue;
      }
      if (value.type === "audio" && this.responseProducedToolCall) continue;
      if (terminal && value.type === "response") {
        if (!this.responseProducedToolCall) deliverable.push(...this.takeBufferedAssistantText());
      }
      deliverable.push(value);
    }
    for (const value of deliverable) this.callbacks.onEvent(value);

    const finalVoiceTranscript = localCompletedUserTranscript(event);
    if (this.config.ownsTurnRouting && finalVoiceTranscript) {
      if (this.implicitResponsePending) {
        if (!this.routeManagedVoiceTranscript(finalVoiceTranscript)) return;
      } else if (this.inputSpeechActive) {
        // Upstream normally emits speech_stopped before the final transcript,
        // but network scheduling can reverse those two events. Retain exactly
        // one completed transcript and route it after the matching stop rather
        // than losing the voice turn or responding while the user is speaking.
        this.pendingCompletedVoiceTranscript = finalVoiceTranscript;
      }
    } else if (
      this.config.ownsTurnRouting
      && event.type === "input_audio_buffer.speech_stopped"
      && this.pendingCompletedVoiceTranscript
    ) {
      const transcript = this.pendingCompletedVoiceTranscript;
      this.pendingCompletedVoiceTranscript = undefined;
      if (!this.routeManagedVoiceTranscript(transcript)) return;
    }

    if (terminal) {
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
      this.activeResponseKind = undefined;
      this.responseProducedOutput = false;
      this.clearBufferedResponseOutput();
      this.clearResponseTimeout();
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
    this.pendingResponseKind = request.kind ?? "conversation";
    this.responseProducedOutput = false;
    this.clearBufferedResponseOutput();
    this.armResponseTimeout();
    try {
      this.sendJson({
        type: "response.create",
        ...(request.response ? { response: request.response } : {}),
      });
    } catch (error) {
      this.responsePending = false;
      this.pendingResponseKind = undefined;
      this.clearResponseTimeout();
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
    if (!this.ready) return;
    this.callbacks.onError?.(error);
    this.closing = true;
    this.reset();
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1011, "Local voice provider error");
    else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
  }

  private reset(): void {
    this.clearResponseTimeout();
    this.responsePending = false;
    this.responseActive = false;
    this.implicitResponsePending = false;
    this.inputSpeechActive = false;
    this.pendingCompletedVoiceTranscript = undefined;
    this.referencedTaskId = undefined;
    this.audioBuffered = false;
    this.activeResponseId = undefined;
    this.pendingResponseKind = undefined;
    this.activeResponseKind = undefined;
    this.responseProducedOutput = false;
    this.clearBufferedResponseOutput();
    this.queue.length = 0;
    this.handledToolCalls.clear();
    this.syntheticToolCalls.clear();
  }

  private armResponseTimeout(): void {
    this.clearResponseTimeout();
    this.responseTimeout = setTimeout(() => {
      this.responseTimeout = undefined;
      if (this.closing || (!this.responsePending && !this.responseActive && !this.implicitResponsePending)) return;
      this.fail(new Error(`Local voice response exceeded ${this.responseTimeoutMs}ms.`));
    }, this.responseTimeoutMs);
    this.responseTimeout.unref?.();
  }

  private clearResponseTimeout(): void {
    if (!this.responseTimeout) return;
    clearTimeout(this.responseTimeout);
    this.responseTimeout = undefined;
  }

  private canRouteAction(action: LocalRoutedAction): boolean {
    return this.availableTools === undefined || this.availableTools.has(action.name);
  }

  private routedAction(text: string): LocalRoutedAction | undefined {
    const explicit = localRoutedAction(text);
    if (explicit) return this.canRouteAction(explicit) ? explicit : undefined;
    const referencedStop: LocalRoutedAction | undefined = this.referencedTaskId
      && /^(?:please\s+)?(?:stop|cancel)\s+(?:it|that|that\s+one|that\s+task)\b/iu.test(text.trim())
      ? { name: "stop_background_task", args: { task_id: this.referencedTaskId } }
      : undefined;
    if (referencedStop && this.canRouteAction(referencedStop)) return referencedStop;
    if (this.availableTools?.has("start_background_task") && isClearLocalWorkRequest(text)) {
      return { name: "start_background_task", args: { message: text } };
    }
    if (this.availableTools?.has("continue_hermes_conversation")) {
      return { name: "continue_hermes_conversation", args: { message: text } };
    }
    return undefined;
  }

  private routeManagedVoiceTranscript(transcript: string): boolean {
    this.pendingCompletedVoiceTranscript = undefined;
    this.implicitResponsePending = false;
    this.clearResponseTimeout();
    const action = this.routedAction(transcript);
    if (action) {
      this.emitSyntheticToolCall(action);
      return !this.closing;
    }
    try {
      this.sendRequest({});
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(errorToMessage(error)));
      return false;
    }
  }

  private emitSyntheticToolCall(action: LocalRoutedAction): void {
    if (this.syntheticToolCalls.size >= LOCAL_MAX_HANDLED_TOOL_CALLS) {
      this.fail(new Error(`Local voice exceeded ${LOCAL_MAX_HANDLED_TOOL_CALLS} routed tool calls in one session.`));
      return;
    }
    const id = `call_local_${randomUUID().replaceAll("-", "")}`;
    this.syntheticToolCalls.set(id, action);
    this.callbacks.onEvent({
      type: "tool_call",
      call: { id, name: action.name, args: action.args },
    });
  }

  private bufferAssistantText(event: Extract<LiveModelEvent, { type: "text" }>): boolean {
    const nextChars = this.bufferedAssistantTextChars + event.text.length;
    if (
      this.bufferedAssistantText.length >= LOCAL_MAX_BUFFERED_ASSISTANT_TEXT_EVENTS
      || nextChars > LOCAL_MAX_BUFFERED_ASSISTANT_TEXT_CHARS
    ) {
      this.fail(new Error("Local voice exceeded the safe assistant transcript buffer limit."));
      return false;
    }
    this.bufferedAssistantText.push(event);
    this.bufferedAssistantTextChars = nextChars;
    return true;
  }

  private takeBufferedAssistantText(): Extract<LiveModelEvent, { type: "text" }>[] {
    const events = this.bufferedAssistantText.splice(0);
    this.bufferedAssistantTextChars = 0;
    if (events.length === 0) return [];

    const completed = events.filter((event) => event.final === true);
    if (completed.length === 1 && completed.length !== events.length) {
      // A conforming Realtime stream publishes zero or more deltas followed
      // by one authoritative completed transcript. Returning both would
      // duplicate the answer in clients that append transcript events.
      return [{ ...completed[0], speaker: "assistant", final: true }];
    }

    // speech-to-speech 0.2.11 publishes each generated text chunk as its own
    // `response.output_audio_transcript.done` event. Coalesce those chunks at
    // the compatibility boundary so clients still receive one assistant turn.
    // If a provider only sends deltas, terminalize the accumulated text here.
    const source = completed.length > 0 ? completed : events;
    const last = source[source.length - 1];
    return [{
      ...last,
      text: source.map((event) => event.text).join(""),
      speaker: "assistant",
      final: true,
    }];
  }

  private dropBufferedAssistantText(): void {
    this.bufferedAssistantText.length = 0;
    this.bufferedAssistantTextChars = 0;
  }

  private clearBufferedResponseOutput(): void {
    this.responseProducedToolCall = false;
    this.dropBufferedAssistantText();
  }
}

export function buildHuggingFaceSessionUpdate(
  config: AppConfig["local"],
  systemInstruction: string,
  availableTools?: LiveModelConnectParams["availableTools"],
): { type: "session.update"; session: Record<string, unknown> } {
  const tools = selectCompactOpenAIHermesLiveTools(availableTools);
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
            create_response: !config.ownsTurnRouting,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: LOCAL_REALTIME_PCM_SAMPLE_RATE },
          voice: config.voice,
        },
      },
      tools,
      tool_choice: tools.length > 0 ? "auto" : "none",
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

function isLocalPipelineBusyError(error: unknown): boolean {
  return /all\s+\d+\s+(?:pipeline|session)\s+slots?\s+(?:are\s+)?in\s+use/iu.test(errorToMessage(error));
}

function localSpokenToolReceipt(response: Record<string, unknown>): string | undefined {
  const value = response.spoken_response;
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 500
    || value.trim().length === 0
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error("Local voice tool receipt is invalid.");
  }
  return value;
}

function localReturnedTaskId(response: Record<string, unknown>): string | undefined {
  const value = response.task_id;
  return typeof value === "string" && /^task_[a-f0-9]{32}$/u.test(value) ? value : undefined;
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

function localResponseStatus(event: any): string | undefined {
  if (event?.type === "response.done") return event?.response?.status ?? "completed";
  if (event?.type === "response.cancelled") return "cancelled";
  if (event?.type === "response.failed") return "failed";
  return typeof event?.response?.status === "string" ? event.response.status : undefined;
}

function isUsableLocalResponseOutput(event: LiveModelEvent): boolean {
  return event.type === "audio"
    || event.type === "tool_call"
    || (event.type === "text" && (event.speaker ?? "assistant") !== "user");
}

function isAssistantText(
  event: LiveModelEvent,
): event is Extract<LiveModelEvent, { type: "text" }> {
  return event.type === "text" && (event.speaker ?? "assistant") !== "user";
}

function localResponseStatusReason(event: any): string | undefined {
  const reason = event?.response?.status_details?.reason;
  return typeof reason === "string" ? reason : undefined;
}

function localCompletedUserTranscript(event: any): string | undefined {
  const transcript = event?.type === "conversation.item.input_audio_transcription.completed"
    ? event.transcript
    : undefined;
  return typeof transcript === "string" && transcript.trim() ? transcript.trim() : undefined;
}

function closeLocalSocket(ws: WebSocket, timeoutMs: number, releaseGraceMs: number): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Local voice session did not close within ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref?.();
    ws.once("close", () => {
      clearTimeout(timeout);
      if (releaseGraceMs <= 0) resolve();
      else setTimeout(resolve, releaseGraceMs);
    });
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "session closed");
    else ws.terminate();
  });
}

function waitForLocalPipelineRelease(closedAt: number, releaseGraceMs: number): Promise<void> {
  const remainingMs = Math.max(0, releaseGraceMs - (Date.now() - closedAt));
  return remainingMs === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, remainingMs));
}
