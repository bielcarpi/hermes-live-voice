import type { Readable, Writable } from "node:stream";
import { clearLine, createInterface, cursorTo } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import WebSocket from "ws";
import type {
  PublicTaskSnapshot,
  ServerMessage,
  TaskNotification,
  TaskLifecycleMessage,
} from "../domain/protocol/server-protocol.js";
import { parseServerMessage as parseProtocolServerMessage } from "../domain/protocol/server-protocol.js";
import { HERMES_LIVE_PROTOCOL_VERSION } from "../domain/protocol/version.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_SERVER_MESSAGE_BYTES = 8_000_000;
const MAX_TERMINAL_TEXT_CHARS = 20_000;
const MAX_RENDERED_TEXT_CHARS = 20_000;
const MAX_PENDING_REQUESTS = 128;
const TASK_LIST_LIMIT = 50;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "cancelled", "unknown"]);

export interface TerminalGatewaySessionOptions {
  url: string;
  authToken?: string;
  userLabel?: string;
  connectTimeoutMs?: number;
  onLine?: (line: string) => void;
}

export interface InteractiveTerminalOptions extends TerminalGatewaySessionOptions {
  input?: Readable;
  output?: Writable;
}

export interface TerminalGatewaySnapshot {
  connected: boolean;
  sessionId?: string;
  provider?: string;
  model?: string;
  responseActive: boolean;
  tasks: PublicTaskSnapshot[];
  activeTaskIds: string[];
  lastTaskId?: string;
}

export interface TerminalCommandResult {
  closeRequested: boolean;
}

type PendingRequest =
  | { kind: "list" }
  | { kind: "status"; taskId: string }
  | { kind: "result"; taskId: string }
  | { kind: "stop"; taskId: string }
  | { kind: "ack"; taskId: string; notificationId: string };

interface TerminalNotificationRevision {
  sequence: number;
  notification: TaskNotification;
}

interface TerminalLifecycleRevision {
  sequence: number;
  content: unknown;
}

type TaskLifecycleEvent = Exclude<
  TaskLifecycleMessage,
  { type: "task.snapshot" | "task.notification" }
>;

/**
 * A text-only client for a running Hermes Live gateway. Background work is
 * server-owned: closing this session detaches and never implies cancellation.
 */
export class TerminalGatewaySession {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly userLabel: string;
  private readonly connectTimeoutMs: number;
  private readonly onLine: (line: string) => void;
  private socket?: WebSocket;
  private ready = false;
  private intentionalClose = false;
  private requestSequence = 0;
  private sessionId?: string;
  private provider?: string;
  private model?: string;
  private responseActive = false;
  private assistantTranscript = "";
  private responseHadAudio = false;
  private readonly tasks = new Map<string, PublicTaskSnapshot>();
  private readonly taskLifecycleSequences = new Map<string, number>();
  private readonly taskLifecycleRevisions = new Map<string, TerminalLifecycleRevision>();
  private readonly taskNotifications = new Map<string, TerminalNotificationRevision>();
  private taskOrder: string[] = [];
  private lastTaskId?: string;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly renderedNotifications = new Set<string>();
  private resolveClosed!: () => void;
  private closedResolved = false;
  readonly closed: Promise<void>;

  constructor(options: TerminalGatewaySessionOptions) {
    this.url = normalizeGatewayWebSocketUrl(options.url);
    this.authToken = options.authToken;
    this.userLabel = sanitizeMetadata(options.userLabel ?? process.env.USER ?? "terminal");
    this.connectTimeoutMs = positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.onLine = options.onLine ?? ((line) => process.stdout.write(`${line}\n`));
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get snapshot(): TerminalGatewaySnapshot {
    const tasks = this.orderedTasks().map(cloneTaskSnapshot);
    return {
      connected: this.ready,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.model ? { model: this.model } : {}),
      responseActive: this.responseActive,
      tasks,
      activeTaskIds: tasks.filter((task) => !TERMINAL_TASK_STATES.has(task.state)).map((task) => task.taskId),
      ...(this.lastTaskId ? { lastTaskId: this.lastTaskId } : {}),
    };
  }

  async connect(): Promise<void> {
    if (this.socket) throw new Error("This terminal gateway session has already been used.");

    const headers = this.authToken ? { authorization: `Bearer ${this.authToken}` } : undefined;
    const socket = new WebSocket(this.url, {
      ...(headers ? { headers } : {}),
      handshakeTimeout: this.connectTimeoutMs,
      followRedirects: false,
      maxPayload: MAX_SERVER_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(() => {
        settle(new Error(`Gateway did not complete the protocol handshake within ${this.connectTimeoutMs}ms.`));
        socket.close(1002, "session handshake timeout");
      }, this.connectTimeoutMs);
      timeout.unref?.();

      socket.once("open", () => {
        socket.send(JSON.stringify({
          type: "session.start",
          protocolVersion: HERMES_LIVE_PROTOCOL_VERSION,
          profileId: "terminal",
          userLabel: this.userLabel,
        }));
      });
      socket.on("message", (raw) => {
        try {
          const message = parseServerMessage(raw);
          if (message.type === "session.ready") {
            this.handleSessionReady(message);
            settle();
            return;
          }
          if (!this.ready && message.type === "session.error") {
            settle(new Error(safeMessage(message.message, "Gateway rejected the terminal session.")));
            socket.close(1002, "session rejected");
            return;
          }
          if (!this.ready) throw new Error(`Gateway sent ${message.type} before session.ready.`);
          this.handleServerMessage(message);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Gateway sent an invalid protocol message.";
          if (!this.ready) settle(new Error(sanitizeTerminalText(message, 500)));
          this.line(`[protocol] ${sanitizeTerminalText(message, 500)}`);
          socket.close(1002, "invalid server message");
        }
      });
      socket.once("error", () => {
        if (!this.ready) settle(new Error("Could not connect to the Hermes Live gateway."));
        else this.line("[connection] Gateway WebSocket error; the session may close.");
      });
      socket.once("close", (code) => {
        const wasReady = this.ready;
        this.ready = false;
        this.responseActive = false;
        this.pendingRequests.clear();
        if (!wasReady) settle(new Error(`Gateway closed before session.ready (code ${code}).`));
        if (wasReady && !this.intentionalClose) {
          this.line(
            `[connection] Disconnected (code ${code}). Background tasks are server-owned and may still be running; reconnect to check them.`,
          );
        }
        this.resolveClosedOnce();
      });
    }).catch((error) => {
      socket.terminate();
      this.resolveClosedOnce();
      throw error;
    });
  }

  execute(input: string): TerminalCommandResult {
    const line = input.trim();
    if (!line) return { closeRequested: false };

    if (!line.startsWith("/")) {
      if (line.length > MAX_TERMINAL_TEXT_CHARS) {
        this.line(`[input] Text is too long for the terminal client (maximum ${MAX_TERMINAL_TEXT_CHARS} characters).`);
        return { closeRequested: false };
      }
      if (this.send({ type: "text.input", id: this.nextRequestId(), text: line })) this.line("[you] Sent.");
      return { closeRequested: false };
    }

    const [rawCommand, ...args] = line.split(/\s+/);
    const command = rawCommand?.toLowerCase();
    switch (command) {
      case "/help":
        this.printHelp();
        break;
      case "/tasks":
        this.requestTaskList();
        break;
      case "/status":
        if (args[0]) this.requestTask(args[0], "status");
        else this.printStatus();
        break;
      case "/result":
        if (args[0]) this.requestTask(args[0], "result");
        else this.line("[input] Usage: /result <taskId>.");
        break;
      case "/ack":
      case "/read":
        if (args[0]) this.requestNotificationAcknowledgement(args[0]);
        else this.line(`[input] Usage: ${command} <taskId>.`);
        break;
      case "/interrupt":
        this.responseActive = false;
        this.send({
          type: "response.cancel",
          id: this.nextRequestId(),
          reason: "terminal user interrupted provider response",
        });
        this.line("[voice] Provider response interruption requested. Background tasks keep running.");
        break;
      case "/stop":
        if (args[0]) this.requestStop(args[0]);
        else this.line("[input] Usage: /stop <taskId>. Name the exact task; /interrupt only stops provider speech.");
        break;
      case "/quit":
      case "/exit":
        return { closeRequested: true };
      default:
        this.line(`[input] Unknown command ${singleLine(rawCommand ?? line, 80)}. Use /help.`);
    }
    return { closeRequested: false };
  }

  async close(): Promise<void> {
    if (this.closedResolved) return;
    this.intentionalClose = true;
    const socket = this.socket;
    if (!socket) {
      this.resolveClosedOnce();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "session.close", id: this.nextRequestId(), detach: true }));
    } else if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }

    await Promise.race([this.closed, delay(Math.max(12_000, this.connectTimeoutMs))]);
    if (!this.closedResolved) {
      socket.terminate();
      await this.closed;
      throw new Error("The gateway did not confirm session detachment; background tasks remain server-owned.");
    }
  }

  private handleSessionReady(message: Extract<ServerMessage, { type: "session.ready" }>): void {
    this.ready = true;
    this.sessionId = message.sessionId;
    this.provider = message.realtime.provider;
    this.model = message.realtime.model;
    const target = [this.provider, this.model].filter(Boolean).join(" / ") || "gateway";
    this.line(`[connection] Connected to ${singleLine(target, 240)} (protocol v${HERMES_LIVE_PROTOCOL_VERSION}).`);
    this.line("[mode] Text-control console: keep talking while durable Hermes tasks work in the background.");
    this.line("[mode] /quit and Ctrl+C detach; only /stop <taskId> cancels a task.");
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "response.started":
        this.responseActive = true;
        this.assistantTranscript = "";
        this.responseHadAudio = false;
        return;
      case "transcript.delta":
        if (message.speaker === "assistant") {
          this.assistantTranscript = `${this.assistantTranscript}${message.text}`.slice(0, MAX_RENDERED_TEXT_CHARS);
        }
        return;
      case "audio.output":
        this.responseHadAudio = true;
        return;
      case "response.completed":
        this.responseActive = false;
        this.flushAssistantResponse();
        return;
      case "response.cancelled":
        this.responseActive = false;
        this.flushAssistantResponse();
        this.line("[voice] Provider response interrupted. Background tasks keep running.");
        return;
      case "response.failed":
        this.responseActive = false;
        this.line(`[voice] Provider response failed: ${safeMessage(message.error, "unknown error")}`);
        this.resetResponseOutput();
        return;
      case "task.snapshot":
        this.handleTaskSnapshot(message);
        return;
      case "task.notification":
        this.handleTaskNotification(message);
        return;
      case "task.accepted":
      case "task.started":
      case "task.progress":
      case "task.stopping":
      case "task.completed":
      case "task.failed":
      case "task.cancelled":
      case "task.unknown":
        if (this.applyTaskLifecycle(message)) this.renderTaskLifecycle(message);
        return;
      case "session.error": {
        if (message.requestId) this.pendingRequests.delete(message.requestId);
        this.line(`[error] ${safeMessage(message.message, "Gateway request failed.")}`);
        return;
      }
      case "log":
        if (message.level === "warn" || message.level === "error") {
          this.line(`[gateway ${message.level}] ${safeMessage(message.message, "Gateway event")}`);
        }
        return;
      case "input.speech_started":
        return;
    }
  }

  private handleTaskSnapshot(message: Extract<ServerMessage, { type: "task.snapshot" }>): void {
    const pending = message.requestId ? this.pendingRequests.get(message.requestId) : undefined;
    if (message.requestId && pending) this.pendingRequests.delete(message.requestId);
    if (pending?.kind === "list" && message.reason !== "list") {
      throw new Error("Gateway task snapshot did not match the task.list request.");
    }
    if ((pending?.kind === "status" || pending?.kind === "result") && message.reason !== "get") {
      throw new Error("Gateway task snapshot did not match the task.get request.");
    }
    if (pending?.kind === "stop" || pending?.kind === "ack") {
      throw new Error(`Gateway task snapshot did not match the pending ${pending.kind} request.`);
    }
    if (pending && "taskId" in pending) {
      if (message.tasks.length > 1 || (message.tasks[0] && message.tasks[0].taskId !== pending.taskId)) {
        throw new Error("Gateway task.get snapshot did not match the requested task id.");
      }
    }

    for (const task of message.tasks) this.upsertTaskSnapshot(task);
    if (message.reason === "initial" || message.reason === "reconnect") {
      if (message.tasks.length > 0) {
        this.line(`[tasks] Restored ${message.tasks.length}${message.truncated ? "+" : ""} task(s). Use /tasks for the inbox.`);
      }
      return;
    }
    if (pending?.kind === "result") {
      const task = message.tasks[0];
      if (!task) this.line(`[Hermes ${pending.taskId}] Task not found.`);
      else this.renderTaskResult(task);
      return;
    }
    if (pending?.kind === "status") {
      const task = message.tasks[0];
      if (!task) this.line(`[Hermes ${pending.taskId}] Task not found.`);
      else this.renderTaskDetail(task);
      return;
    }
    if (message.reason === "list") this.renderTaskList(message.tasks, message.truncated);
  }

  private applyTaskLifecycle(message: TaskLifecycleEvent): boolean {
    const requestId = "requestId" in message ? message.requestId : undefined;
    const pending = requestId
      ? this.pendingRequests.get(requestId)
      : undefined;
    if (requestId) {
      if (!pending || pending.kind !== "stop") {
        throw new Error("Gateway sent an uncorrelated task lifecycle response.");
      }
      if (message.taskId !== pending.taskId) throw new Error("Gateway stop response did not match the requested task id.");
      this.pendingRequests.delete(requestId!);
    }

    const existing = this.tasks.get(message.taskId);
    const lifecycleSequence = this.taskLifecycleSequences.get(message.taskId) ?? 0;
    if (message.sequence < lifecycleSequence) return false;

    const revision = lifecycleRevision(message);
    if (message.sequence === lifecycleSequence) {
      const retainedRevision = this.taskLifecycleRevisions.get(message.taskId);
      if (retainedRevision && !isDeepStrictEqual(retainedRevision.content, revision.content)) {
        throw new Error(`Gateway sent conflicting lifecycle content for ${message.taskId} at sequence ${message.sequence}.`);
      }
      if (existing) {
        const candidate = this.taskFromLifecycle(existing, message);
        assertCompatibleTaskRevision(existing, candidate);
      }
      if (!retainedRevision) this.taskLifecycleRevisions.set(message.taskId, revision);
      return false;
    }

    const base = this.taskFromLifecycle(existing, message);
    this.retainTask(base);
    this.taskLifecycleSequences.set(message.taskId, message.sequence);
    this.taskLifecycleRevisions.set(message.taskId, revision);
    return true;
  }

  private taskFromLifecycle(
    existing: PublicTaskSnapshot | undefined,
    message: TaskLifecycleEvent,
  ): PublicTaskSnapshot {
    const createdAt = existing?.createdAt ?? message.occurredAt;
    const base: PublicTaskSnapshot = {
      ...(existing ? cloneTaskSnapshot(existing) : {
        taskId: message.taskId,
        sequence: message.sequence,
        state: "accepted" as const,
        createdAt,
        updatedAt: message.occurredAt,
      }),
      taskId: message.taskId,
      sequence: Math.max(existing?.sequence ?? 0, message.sequence),
      updatedAt: Math.max(existing?.updatedAt ?? 0, message.occurredAt),
    };

    switch (message.type) {
      case "task.accepted":
        base.state = message.state;
        if (message.title) base.title = message.title;
        break;
      case "task.started":
        base.state = "running";
        base.startedAt ??= message.occurredAt;
        if (message.title) base.title = message.title;
        break;
      case "task.progress":
        base.state = existing?.state === "stopping" ? "stopping" : "running";
        base.progress = message.progress;
        break;
      case "task.stopping":
        base.state = "stopping";
        base.progress = { message: message.reason || "Stop requested." };
        break;
      case "task.completed":
        base.state = "completed";
        base.finishedAt = message.occurredAt;
        base.result = message.result;
        delete base.error;
        break;
      case "task.failed":
        base.state = "failed";
        base.finishedAt = message.occurredAt;
        base.error = message.error;
        break;
      case "task.cancelled":
        base.state = "cancelled";
        base.finishedAt = message.occurredAt;
        base.progress = { message: message.reason || "Task cancelled." };
        break;
      case "task.unknown":
        base.state = "unknown";
        base.error = message.error;
        break;
    }
    return base;
  }

  private renderTaskLifecycle(message: TaskLifecycleEvent): void {
    const id = message.taskId;
    switch (message.type) {
      case "task.accepted":
        this.line(`[Hermes ${id}] ${message.state === "queued" ? "Queued" : "Accepted"}${message.title ? `: ${singleLine(message.title, 256)}` : "."}`);
        break;
      case "task.started":
        this.line(`[Hermes ${id}] Started${message.title ? `: ${singleLine(message.title, 256)}` : "."}`);
        break;
      case "task.progress":
        this.line(`[Hermes ${id}] ${singleLine(message.progress.message, 1_000)}`);
        break;
      case "task.stopping":
        this.line(`[Hermes ${id}] Stop accepted; waiting for terminal confirmation.`);
        break;
      case "task.completed":
        this.line(`[Hermes ${id}] Completed.`);
        this.renderTaskResult(this.tasks.get(id)!);
        break;
      case "task.failed":
        this.line(`[Hermes ${id}] Failed: ${singleLine(message.error.message, 2_000)}`);
        break;
      case "task.cancelled":
        this.line(`[Hermes ${id}] Cancelled${message.reason ? `: ${singleLine(message.reason, 1_000)}` : "."}`);
        break;
      case "task.unknown":
        this.line(`[Hermes ${id}] Outcome unknown: ${singleLine(message.error.message, 2_000)}`);
        break;
    }
  }

  private requestTaskList(): void {
    const id = this.nextRequestId();
    if (this.trackAndSend(id, { kind: "list" }, { type: "task.list", id, limit: TASK_LIST_LIMIT })) {
      this.line("[tasks] Refresh requested.");
    }
  }

  private requestTask(taskIdInput: string, kind: "status" | "result"): void {
    const taskId = validTaskId(taskIdInput);
    if (!taskId) {
      this.line(`[input] Invalid task id ${singleLine(taskIdInput, 120)}.`);
      return;
    }
    const id = this.nextRequestId();
    this.trackAndSend(id, { kind, taskId }, { type: "task.get", id, taskId });
  }

  private requestStop(taskIdInput: string): void {
    const taskId = validTaskId(taskIdInput);
    if (!taskId) {
      this.line(`[input] Invalid task id ${singleLine(taskIdInput, 120)}.`);
      return;
    }
    const id = this.nextRequestId();
    if (this.trackAndSend(id, { kind: "stop", taskId }, {
      type: "task.stop",
      id,
      taskId,
      reason: "terminal user stopped this exact Hermes task",
    })) {
      this.line(`[Hermes ${taskId}] Stop requested.`);
    }
  }

  private requestNotificationAcknowledgement(taskIdInput: string): void {
    const taskId = validTaskId(taskIdInput);
    if (!taskId) {
      this.line(`[input] Invalid task id ${singleLine(taskIdInput, 120)}.`);
      return;
    }
    const current = this.taskNotifications.get(taskId);
    if (!current || current.notification.acknowledged) {
      this.line(`[notification] ${taskId} has no unread notification to acknowledge.`);
      return;
    }
    const id = this.nextRequestId();
    const notificationId = current.notification.notificationId;
    if (this.trackAndSend(id, { kind: "ack", taskId, notificationId }, {
      type: "task.notification.ack",
      id,
      taskId,
      notificationId,
    })) {
      this.line(`[notification] Mark-read requested for ${taskId}.`);
    }
  }

  private trackAndSend(id: string, pending: PendingRequest, message: Record<string, unknown>): boolean {
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      this.line("[input] Too many terminal requests are awaiting replies; wait for the gateway before trying again.");
      return false;
    }
    if (!this.send(message)) return false;
    this.pendingRequests.set(id, pending);
    return true;
  }

  private upsertTaskSnapshot(task: PublicTaskSnapshot): void {
    const existing = this.tasks.get(task.taskId);
    const lifecycleSequence = this.taskLifecycleSequences.get(task.taskId) ?? 0;
    if (task.sequence < lifecycleSequence) return;
    if (existing && task.sequence === lifecycleSequence) {
      assertCompatibleTaskRevision(existing, task);
      this.retainTask(mergeEqualSequenceTask(existing, task));
      return;
    }

    const next = existing && task.sequence < existing.sequence
      ? mergeNewerLifecycleSnapshot(existing, task)
      : task;
    this.retainTask(next);
    this.taskLifecycleSequences.set(task.taskId, task.sequence);
    this.taskLifecycleRevisions.delete(task.taskId);
  }

  private retainTask(task: PublicTaskSnapshot): void {
    this.tasks.set(task.taskId, cloneTaskSnapshot(task));
    this.taskOrder = [task.taskId, ...this.taskOrder.filter((id) => id !== task.taskId)];
    this.lastTaskId = task.taskId;
  }

  private handleTaskNotification(message: Extract<ServerMessage, { type: "task.notification" }>): void {
    const pending = message.requestId ? this.pendingRequests.get(message.requestId) : undefined;
    if (message.requestId) {
      if (!pending || pending.kind !== "ack") {
        throw new Error("Gateway sent an uncorrelated task notification acknowledgement.");
      }
      if (
        pending.taskId !== message.taskId ||
        pending.notificationId !== message.notification.notificationId
      ) {
        throw new Error("Gateway notification acknowledgement did not match the requested task and notification ids.");
      }
      if (!message.notification.acknowledged) {
        throw new Error("Gateway notification acknowledgement response was not acknowledged.");
      }
      this.pendingRequests.delete(message.requestId);
    }

    const retained = this.taskNotifications.get(message.taskId);
    if (retained && message.sequence < retained.sequence) return;
    if (retained && message.sequence === retained.sequence) {
      if (!isDeepStrictEqual(retained.notification, message.notification)) {
        throw new Error(`Gateway sent conflicting notification content for ${message.taskId} at sequence ${message.sequence}.`);
      }
      return;
    }

    this.taskNotifications.set(message.taskId, {
      sequence: message.sequence,
      notification: structuredClone(message.notification),
    });
    const task = this.tasks.get(message.taskId);
    if (task && message.sequence > task.sequence) {
      this.retainTask({
        ...cloneTaskSnapshot(task),
        sequence: message.sequence,
        updatedAt: Math.max(task.updatedAt, message.occurredAt),
      });
    }
    if (
      !message.notification.acknowledged &&
      !this.renderedNotifications.has(message.notification.notificationId)
    ) {
      this.renderedNotifications.add(message.notification.notificationId);
      this.line(`[notification] ${singleLine(message.notification.message, 1_000)} (${message.taskId})`);
    }
  }

  private orderedTasks(): PublicTaskSnapshot[] {
    return this.taskOrder.flatMap((id) => {
      const task = this.tasks.get(id);
      return task ? [task] : [];
    });
  }

  private renderTaskList(tasks: readonly PublicTaskSnapshot[], truncated: boolean): void {
    if (tasks.length === 0) {
      this.line("[tasks] Inbox is empty.");
      return;
    }
    this.line(`[tasks] ${tasks.length}${truncated ? "+" : ""} task(s):`);
    for (const task of tasks) {
      const title = task.title ? ` — ${singleLine(task.title, 200)}` : "";
      this.line(`  ${task.taskId}  ${task.state}${title}`);
    }
  }

  private renderTaskDetail(task: PublicTaskSnapshot): void {
    const progress = task.progress?.message ? `\n  progress: ${singleLine(task.progress.message, 1_000)}` : "";
    const error = task.error?.message ? `\n  error: ${singleLine(task.error.message, 2_000)}` : "";
    this.line(`[Hermes ${task.taskId}]\n  state: ${task.state}\n  sequence: ${task.sequence}${task.title ? `\n  title: ${singleLine(task.title, 256)}` : ""}${progress}${error}`);
  }

  private renderTaskResult(task: PublicTaskSnapshot): void {
    if (task.state === "completed") {
      const output = sanitizeTerminalText(task.result?.output ?? task.result?.summary ?? "Task completed without text output.", MAX_RENDERED_TEXT_CHARS).trim();
      this.line(`[result ${task.taskId}]${output ? `\n${indentMultiline(output)}` : " No text output."}`);
      return;
    }
    if (task.state === "failed" || task.state === "unknown") {
      this.line(`[result ${task.taskId}] ${task.state}: ${safeMessage(task.error?.message, "No result is available.")}`);
      return;
    }
    if (task.state === "cancelled") {
      this.line(`[result ${task.taskId}] cancelled.`);
      return;
    }
    this.line(`[result ${task.taskId}] Task is ${task.state}; no terminal result is available yet.`);
  }

  private flushAssistantResponse(): void {
    const transcript = sanitizeTerminalText(this.assistantTranscript.trim(), MAX_RENDERED_TEXT_CHARS);
    if (transcript) this.line(prefixMultiline("[voice] ", transcript));
    else if (this.responseHadAudio) {
      this.line("[voice] Audio response received. Use the Hermes Dashboard or browser demo to hear gateway audio.");
    }
    this.resetResponseOutput();
  }

  private resetResponseOutput(): void {
    this.assistantTranscript = "";
    this.responseHadAudio = false;
  }

  private printHelp(): void {
    this.line(`Commands:
  <text>                 Send a text turn through the realtime gateway
  /tasks                 Refresh the durable task inbox
  /status                Show local connection and task counts
  /status <taskId>       Fetch one task's current state
  /result <taskId>       Fetch one task's retained result
  /ack <taskId>          Mark that task's exact unread notification as read
  /read <taskId>         Alias for /ack
  /stop <taskId>         Stop exactly one background task
  /interrupt             Stop provider speech/response; tasks keep running
  /quit                  Detach from the gateway; tasks keep running
  /help                  Show this help

Interactive task approvals are unavailable and are contained fail-closed.
This console intentionally has no microphone/audio dependencies. For local voice,
run Hermes and press Ctrl+B. For remote gateway audio, use the Dashboard/browser UI.`);
  }

  private printStatus(): void {
    const tasks = this.orderedTasks();
    const active = tasks.filter((task) => !TERMINAL_TASK_STATES.has(task.state));
    const unreadResults = tasks.filter((task) => TERMINAL_TASK_STATES.has(task.state));
    const unreadNotifications = [...this.taskNotifications.values()]
      .filter((revision) => !revision.notification.acknowledged).length;
    this.line(`Status:
  connection: ${this.ready ? "ready" : "not ready"}
  provider: ${singleLine(this.provider ?? "unknown", 120)}
  model: ${singleLine(this.model ?? "unknown", 200)}
  provider response: ${this.responseActive ? "active" : "idle"}
  Hermes tasks: ${active.length} active; ${unreadResults.length} terminal; ${tasks.length} retained
  notifications: ${unreadNotifications} unread
  last task: ${this.lastTaskId ?? "none"}`);
  }

  private send(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) {
      this.line("[connection] The gateway session is not ready.");
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `terminal_${this.requestSequence}`;
  }

  private line(value: string): void {
    this.onLine(sanitizeTerminalText(value, MAX_RENDERED_TEXT_CHARS));
  }

  private resolveClosedOnce(): void {
    if (this.closedResolved) return;
    this.closedResolved = true;
    this.resolveClosed();
  }
}

export async function runInteractiveTerminal(options: InteractiveTerminalOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive = Boolean((input as Readable & { isTTY?: boolean }).isTTY && (output as Writable & { isTTY?: boolean }).isTTY);
  let reader: ReturnType<typeof createInterface> | undefined;
  let promptVisible = false;

  const render = (line: string): void => {
    if (interactive && reader && promptVisible) {
      clearLine(output, 0);
      cursorTo(output, 0);
    }
    output.write(line.endsWith("\n") ? line : `${line}\n`);
    if (interactive && reader && promptVisible) reader.prompt(true);
  };

  const session = new TerminalGatewaySession({ ...options, onLine: render });
  await session.connect();
  render("[help] Type /help for controls. Disconnecting detaches; background tasks keep running.");

  reader = createInterface({ input, output, terminal: interactive });
  if (interactive) {
    reader.setPrompt("hermes-live> ");
    promptVisible = true;
    reader.prompt();
  }

  await new Promise<void>((resolve, reject) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      promptVisible = false;
      reader?.close();
      input.pause();
      void session.close().then(resolve, reject);
    };

    reader?.on("line", (line) => {
      const result = session.execute(line);
      if (result.closeRequested) shutdown();
      else if (interactive) reader?.prompt();
    });
    reader?.on("SIGINT", () => {
      if (session.snapshot.responseActive) {
        session.execute("/interrupt");
        if (interactive) reader?.prompt();
      } else {
        shutdown();
      }
    });
    reader?.once("close", shutdown);
    void session.closed.then(() => {
      if (shuttingDown) return;
      shuttingDown = true;
      promptVisible = false;
      reader?.close();
      input.pause();
      resolve();
    });
  });
}

export function normalizeGatewayWebSocketUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HERMES_LIVE_URL must be an absolute http(s) or ws(s) URL.");
  }
  if (url.username || url.password) {
    throw new Error("HERMES_LIVE_URL must not contain credentials; use HERMES_LIVE_AUTH_TOKEN.");
  }
  if (url.searchParams.has("token")) {
    throw new Error("HERMES_LIVE_URL must not contain a token query; use HERMES_LIVE_AUTH_TOKEN.");
  }
  if (url.hash) throw new Error("HERMES_LIVE_URL must not contain a URL fragment.");
  if (url.protocol === "http:" || url.protocol === "https:") {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = basePath.endsWith("/v1/live") ? basePath : `${basePath}/v1/live`;
  } else if (url.protocol === "ws:" || url.protocol === "wss:") {
    if (url.pathname === "/" || !url.pathname) url.pathname = "/v1/live";
  } else {
    throw new Error("HERMES_LIVE_URL must use http, https, ws, or wss.");
  }
  return url.toString();
}

export function sanitizeTerminalText(value: string, maxChars = MAX_RENDERED_TEXT_CHARS): string {
  const withoutTerminalSequences = value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "");
  const sanitized: string[] = [];
  for (const character of withoutTerminalSequences) {
    if (sanitized.length >= maxChars) break;
    const code = character.charCodeAt(0);
    if (
      character === "\n" ||
      character === "\t" ||
      (
        code >= 32 &&
        code !== 127 &&
        !(code >= 128 && code <= 159) &&
        code !== 0x061c &&
        code !== 0x200e &&
        code !== 0x200f &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069)
      )
    ) {
      sanitized.push(character);
    }
  }
  return sanitized.join("");
}

function parseServerMessage(raw: WebSocket.RawData): ServerMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new Error("Gateway sent invalid JSON.");
  }
  const record = recordValue(value);
  if (!record || typeof record.type !== "string") throw new Error("Gateway sent an invalid protocol message.");
  if (record.type === "session.ready" && record.protocolVersion !== HERMES_LIVE_PROTOCOL_VERSION) {
    throw new Error(
      `Gateway protocol mismatch: expected v${HERMES_LIVE_PROTOCOL_VERSION}, received ${String(record.protocolVersion)}.`,
    );
  }
  const parsed = parseProtocolServerMessage(value);
  return parsed;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function safeMessage(value: unknown, fallback: string): string {
  return singleLine(typeof value === "string" && value ? value : fallback, 500);
}

function singleLine(value: string, maxChars: number): string {
  return sanitizeTerminalText(value, maxChars).replace(/\s+/g, " ").trim();
}

function prefixMultiline(prefix: string, value: string): string {
  const [first = "", ...rest] = value.split("\n");
  return `${prefix}${first}${rest.length > 0 ? `\n${rest.map((line) => `  ${line}`).join("\n")}` : ""}`;
}

function indentMultiline(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

function sanitizeMetadata(value: string): string {
  return singleLine(value, 256) || "terminal";
}

function validTaskId(value: string): string | undefined {
  return TASK_ID_PATTERN.test(value) ? value : undefined;
}

function cloneTaskSnapshot(task: PublicTaskSnapshot): PublicTaskSnapshot {
  return {
    ...task,
    ...(task.progress ? { progress: { ...task.progress } } : {}),
    ...(task.result ? { result: { ...task.result, ...(task.result.usage ? { usage: { ...task.result.usage } } : {}) } } : {}),
    ...(task.error ? { error: { ...task.error } } : {}),
  };
}

function lifecycleRevision(message: TaskLifecycleEvent): TerminalLifecycleRevision {
  const { requestId: _requestId, ...content } = message as TaskLifecycleEvent & { requestId?: string };
  return { sequence: message.sequence, content };
}

function assertCompatibleTaskRevision(
  retained: PublicTaskSnapshot,
  incoming: PublicTaskSnapshot,
): void {
  const conflict = (field: string): never => {
    throw new Error(
      `Gateway sent conflicting ${field} for ${incoming.taskId} at sequence ${incoming.sequence}.`,
    );
  };
  if (retained.taskId !== incoming.taskId) conflict("task id");
  if (retained.state !== incoming.state) conflict("task state");
  assertCompatibleOptional(retained.title, incoming.title, "task title", conflict);
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
    if (!isDeepStrictEqual(retained.error, incoming.error)) conflict("task error");
  } else if (
    Boolean(retained.error) !== Boolean(incoming.error) &&
    (incoming.state === "failed" || incoming.state === "unknown")
  ) {
    conflict("task error");
  }
}

function assertCompatibleOptional(
  retained: unknown,
  incoming: unknown,
  field: string,
  conflict: (field: string) => never,
): void {
  if (retained !== undefined && incoming !== undefined && !isDeepStrictEqual(retained, incoming)) {
    conflict(field);
  }
}

function mergeEqualSequenceTask(
  retained: PublicTaskSnapshot,
  incoming: PublicTaskSnapshot,
): PublicTaskSnapshot {
  const next = cloneTaskSnapshot(retained);
  next.sequence = Math.max(retained.sequence, incoming.sequence);
  next.updatedAt = Math.max(retained.updatedAt, incoming.updatedAt);
  if (next.title === undefined && incoming.title !== undefined) next.title = incoming.title;
  if (next.startedAt === undefined && incoming.startedAt !== undefined) next.startedAt = incoming.startedAt;
  if (next.finishedAt === undefined && incoming.finishedAt !== undefined) next.finishedAt = incoming.finishedAt;
  if (next.progress === undefined && incoming.progress !== undefined) next.progress = { ...incoming.progress };
  if (incoming.result) {
    if (!next.result) {
      next.result = cloneTaskSnapshot(incoming).result;
    } else {
      if (next.result.summary === undefined && incoming.result.summary !== undefined) {
        next.result.summary = incoming.result.summary;
      }
      if (next.result.output === undefined && incoming.result.output !== undefined) {
        next.result.output = incoming.result.output;
        next.result.truncated = incoming.result.truncated;
      }
      if (next.result.usage === undefined && incoming.result.usage !== undefined) {
        next.result.usage = { ...incoming.result.usage };
      }
    }
  }
  if (!next.error && incoming.error) next.error = { ...incoming.error };
  return next;
}

function mergeNewerLifecycleSnapshot(
  retained: PublicTaskSnapshot,
  incoming: PublicTaskSnapshot,
): PublicTaskSnapshot {
  const next = cloneTaskSnapshot(incoming);
  next.sequence = Math.max(retained.sequence, incoming.sequence);
  next.updatedAt = Math.max(retained.updatedAt, incoming.updatedAt);
  if (
    retained.state === incoming.state &&
    retained.result?.output !== undefined &&
    next.result !== undefined &&
    next.result.output === undefined
  ) {
    next.result.output = retained.result.output;
    next.result.truncated = retained.result.truncated;
  }
  return next;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}
