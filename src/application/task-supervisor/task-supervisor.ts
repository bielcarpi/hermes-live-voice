import type {
  SubmitBackgroundTaskInput,
  TaskNotificationAnnouncementClaim,
  TaskRecordListener,
  TaskSupervisorPort,
} from "../live-gateway/ports/task-supervisor.port.js";
import type {
  HermesRunSnapshot,
  HermesRunsPort,
} from "../live-gateway/ports/hermes-runs.port.js";
import type { TaskStorePort } from "./ports/task-store.port.js";
import {
  MAX_TASK_OUTPUT_CHARS,
  TaskIdSchema,
  TaskOwnerIdSchema,
  TaskStatusSchema,
  appendTaskEvent,
  acknowledgeTaskNotification,
  canTransitionTask,
  createTaskRecord,
  hashTaskOwnerId,
  isTaskTerminal,
  markTaskStopRequested,
  markTaskNotificationAnnounced,
  sanitizeTaskEventSummary,
  transitionTask,
  type TaskRecord,
  type TaskStatus,
  type TaskTransitionOptions,
} from "../../domain/tasks/index.js";
import type { HermesRunEvent } from "../../domain/protocol/server-protocol.js";

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 30_000;
const MAX_PROGRESS_EVENTS_PER_TASK = 64;
const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  "dispatching",
  "running",
  "waiting_for_approval",
  "stopping",
  "unknown",
  "dispatch_unknown",
]);
const OWNER_ACTIVE_TASK_STATUSES: readonly TaskStatus[] = TaskStatusSchema.options.filter(
  (status) => !isTaskTerminal(status),
);

export interface TaskSupervisorScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TaskSupervisorOptions {
  store: TaskStorePort;
  hermes: HermesRunsPort;
  maxConcurrent?: number;
  maxQueued?: number;
  pollIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  runInstructions?: string;
  now?: () => number;
  scheduler?: TaskSupervisorScheduler;
  onError?: (error: unknown) => void;
}

export class TaskQueueFullError extends Error {
  constructor(limit: number) {
    super(`The background task queue has reached its ${limit}-task limit.`);
    this.name = "TaskQueueFullError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskSupervisorClosedError extends Error {
  constructor() {
    super("The task supervisor is closed.");
    this.name = "TaskSupervisorClosedError";
  }
}

/**
 * Server-owned background task runtime. Every state emitted to a subscriber has
 * already been durably written through TaskStorePort.
 */
export class TaskSupervisor implements TaskSupervisorPort {
  private readonly store: TaskStorePort;
  private readonly hermes: HermesRunsPort;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly pollIntervalMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly runInstructions?: string;
  private readonly now: () => number;
  private readonly scheduler: TaskSupervisorScheduler;
  private readonly onError?: (error: unknown) => void;
  private readonly ownerSessionKeys = new Map<string, string>();
  private readonly subscribers = new Map<string, Set<TaskRecordListener>>();
  private readonly timers = new Map<string, unknown>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryNotBefore = new Map<string, number>();
  private readonly progressEventCounts = new Map<string, number>();
  private readonly watching = new Set<string>();
  private readonly pollSuppressed = new Set<string>();
  private readonly confirmedMissing = new Set<string>();
  private readonly confirmedStopRequests = new Set<string>();
  private readonly stopRequests = new Map<string, Promise<void>>();
  private readonly containingApprovals = new Set<string>();
  private readonly backgroundOperations = new Set<Promise<void>>();
  private readonly abortController = new AbortController();
  private operationTail: Promise<void> = Promise.resolve();
  private initializePromise?: Promise<void>;
  private initialized = false;
  private closed = false;
  private drainQueued = false;
  private drainRunning = false;
  private drainRequested = false;
  private lastCreatedAt?: number;

  constructor(options: TaskSupervisorOptions) {
    this.store = options.store;
    this.hermes = options.hermes;
    this.maxConcurrent = positiveInteger(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, "maxConcurrent");
    this.maxQueued = nonNegativeInteger(options.maxQueued ?? DEFAULT_MAX_QUEUED, "maxQueued");
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
    this.retryBaseMs = positiveInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, "retryBaseMs");
    this.retryMaxMs = positiveInteger(options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS, "retryMaxMs");
    if (this.retryMaxMs < this.retryBaseMs) throw new Error("retryMaxMs must be at least retryBaseMs.");
    this.runInstructions = options.runInstructions;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onError = options.onError;
  }

  initialize(): Promise<void> {
    this.assertOpen();
    if (!this.initializePromise) this.initializePromise = this.initializeOnce();
    return this.initializePromise;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    for (const handle of this.timers.values()) this.scheduler.clearTimeout(handle);
    this.timers.clear();
    this.watching.clear();
    this.subscribers.clear();
    this.ownerSessionKeys.clear();
    while (true) {
      await this.operationTail;
      const pending = [...this.backgroundOperations];
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
    await this.operationTail;
  }

  registerOwner(ownerIdentity: string, sessionKey: string): string {
    this.assertOpen();
    const ownerId = hashTaskOwnerId(ownerIdentity);
    this.ownerSessionKeys.set(ownerId, validateSessionKey(sessionKey));
    if (this.initialized) this.scheduleDrain();
    return ownerId;
  }

  async submit(input: SubmitBackgroundTaskInput): Promise<TaskRecord> {
    this.assertReady();
    const ownerId = this.registerOwner(input.ownerIdentity, input.sessionKey);
    const record = await this.serialized(async () => {
      const queued = await this.store.list({ statuses: ["queued"] });
      if (queued.length >= this.maxQueued) throw new TaskQueueFullError(this.maxQueued);
      const created = createTaskRecord({
        ownerIdentity: input.ownerIdentity,
        input: input.input,
        title: input.title,
        executionMode: input.executionMode,
        resourceKeys: input.resourceKeys,
        now: this.nextCreationTimestamp(),
      });
      if (created.ownerId !== ownerId) throw new Error("Task owner registration mismatch.");
      const persisted = await this.store.put(created);
      this.publish(persisted);
      return persisted;
    });
    this.scheduleDrain();
    return cloneTask(record);
  }

  list(ownerId: string, limit = 100): Promise<TaskRecord[]> {
    this.assertReady();
    const parsedOwnerId = TaskOwnerIdSchema.parse(ownerId);
    const parsedLimit = positiveInteger(limit, "task list limit");
    return this.store.list({ ownerId: parsedOwnerId, limit: parsedLimit }).then((records) => records.map(cloneTask));
  }

  listActive(ownerId: string): Promise<TaskRecord[]> {
    this.assertReady();
    const parsedOwnerId = TaskOwnerIdSchema.parse(ownerId);
    return this.store.list({
      ownerId: parsedOwnerId,
      statuses: OWNER_ACTIVE_TASK_STATUSES,
    }).then((records) => records.map(cloneTask));
  }

  listUnreadNotifications(ownerId: string): Promise<TaskRecord[]> {
    this.assertReady();
    const parsedOwnerId = TaskOwnerIdSchema.parse(ownerId);
    return this.store.list({
      ownerId: parsedOwnerId,
      notificationUnread: true,
    }).then((records) => records.map(cloneTask));
  }

  async get(ownerId: string, taskId: string): Promise<TaskRecord | undefined> {
    this.assertReady();
    const parsedOwnerId = TaskOwnerIdSchema.parse(ownerId);
    const record = await this.store.load(TaskIdSchema.parse(taskId));
    return record?.ownerId === parsedOwnerId ? cloneTask(record) : undefined;
  }

  async stop(ownerId: string, taskId: string, reason?: string): Promise<TaskRecord> {
    this.assertReady();
    const parsedOwnerId = TaskOwnerIdSchema.parse(ownerId);
    const parsedTaskId = TaskIdSchema.parse(taskId);
    const cancellationSummary = reason
      ? `Task cancelled: ${sanitizeTaskEventSummary(reason)}`
      : "Queued task cancelled.";
    let record = await this.mutatePersist(parsedTaskId, (current) => {
      if (current.ownerId !== parsedOwnerId) throw new TaskNotFoundError(parsedTaskId);
      if (current.status === "queued") {
        return transitionTask(current, "cancelled", { now: this.now(), summary: cancellationSummary });
      }
      if (isTaskTerminal(current.status)) return current;
      return markTaskStopRequested(current, {
        now: this.now(),
        summary: current.status === "dispatching"
          ? "Exact task stop requested while dispatch was in flight."
          : "Exact task stop requested.",
      });
    });
    if (record.status === "cancelled") {
      this.scheduleDrain();
      return record;
    }
    if (isTaskTerminal(record.status)) return record;
    if (record.status === "dispatching") {
      // Dispatch completion and this stop request race outside the serialized
      // store update. The durable stopRequestedAt marker is consumed after a
      // confirmed run id arrives; if the gateway restarts first, recovery keeps
      // the same intent instead of silently resuming the task.
      record = await this.requireOwned(parsedOwnerId, parsedTaskId);
      if (record.status === "dispatching") return record;
      if (isTaskTerminal(record.status)) return record;
    }
    if (!record.runId) return record;
    return this.requestStop(record, reason);
  }

  acknowledgeNotification(ownerId: string, taskId: string): Promise<TaskRecord> {
    return this.updateOwnedNotification(ownerId, taskId, (record) =>
      acknowledgeTaskNotification(record, this.now()));
  }

  markNotificationAnnounced(ownerId: string, taskId: string): Promise<TaskRecord> {
    return this.updateOwnedNotification(ownerId, taskId, (record) =>
      markTaskNotificationAnnounced(record, this.now()));
  }

  claimNotificationAnnouncement(
    ownerId: string,
    taskId: string,
  ): Promise<TaskNotificationAnnouncementClaim> {
    this.assertReady();
    const parsedOwnerId = TaskOwnerIdSchema.parse(ownerId);
    const parsedTaskId = TaskIdSchema.parse(taskId);
    return this.serialized(async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = await this.store.load(parsedTaskId);
        if (!current || current.ownerId !== parsedOwnerId) throw new TaskNotFoundError(parsedTaskId);
        if (!current.notification.unread || current.notification.announcedAt !== undefined) {
          return { claimed: false, task: cloneTask(current) };
        }
        const updated = markTaskNotificationAnnounced(current, this.now());
        try {
          const persisted = await this.store.update(
            parsedTaskId,
            () => updated,
            { expectedRevision: current.revision },
          );
          this.publish(persisted);
          return { claimed: true, task: cloneTask(persisted) };
        } catch (error) {
          if (errorName(error) !== "TaskStoreConflictError" || attempt === 3) throw error;
        }
      }
      throw new Error("Task notification announcement claim retry loop exhausted.");
    });
  }

  subscribe(ownerId: string, listener: TaskRecordListener): () => void {
    this.assertOpen();
    const parsedOwnerId = TaskOwnerIdSchema.parse(ownerId);
    if (typeof listener !== "function") throw new Error("Task subscriber must be a function.");
    const listeners = this.subscribers.get(parsedOwnerId) ?? new Set<TaskRecordListener>();
    listeners.add(listener);
    this.subscribers.set(parsedOwnerId, listeners);
    return () => {
      const current = this.subscribers.get(parsedOwnerId);
      current?.delete(listener);
      if (current?.size === 0) this.subscribers.delete(parsedOwnerId);
    };
  }

  private async initializeOnce(): Promise<void> {
    const records = await this.store.list();
    this.lastCreatedAt = records.reduce<number | undefined>(
      (latest, record) => latest === undefined ? record.createdAt : Math.max(latest, record.createdAt),
      this.lastCreatedAt,
    );
    for (const record of records) {
      if (this.closed) return;
      if (record.status === "dispatching" && !record.runId) {
        await this.transitionPersist(record.taskId, "dispatch_unknown", {
          summary: "Dispatch outcome is unknown after supervisor restart.",
        });
        continue;
      }
      if (record.runId && !isTaskTerminal(record.status)) {
        await this.reconcileTask(record.taskId);
        const reconciled = await this.store.load(record.taskId);
        if (reconciled?.runId && !isTaskTerminal(reconciled.status)) this.startWatcher(reconciled);
      }
    }
    this.initialized = true;
    this.scheduleDrain();
  }

  private async requestStop(record: TaskRecord, reason?: string): Promise<TaskRecord> {
    let stopping = record;
    if (stopping.stopRequestedAt === undefined) {
      stopping = await this.mutatePersist(stopping.taskId, (current) =>
        isTaskTerminal(current.status)
          ? current
          : markTaskStopRequested(current, { now: this.now(), summary: "Exact task stop requested." }));
    }
    if (stopping.status !== "stopping" && canTransitionTask(stopping.status, "stopping")) {
      stopping = await this.transitionPersist(stopping.taskId, "stopping", {
        summary: reason ? `Stop requested: ${sanitizeTaskEventSummary(reason)}` : "Stop requested.",
      });
    }
    if (!stopping.runId || isTaskTerminal(stopping.status)) return stopping;
    if (this.confirmedStopRequests.has(stopping.taskId)) return stopping;
    let request = this.stopRequests.get(stopping.taskId);
    if (!request) {
      request = this.sendStopRequest(stopping);
      this.stopRequests.set(stopping.taskId, request);
      this.trackBackground(request);
      void request.finally(() => this.stopRequests.delete(stopping.taskId)).catch(() => undefined);
    }
    await request;
    return (await this.get(stopping.ownerId, stopping.taskId)) ?? stopping;
  }

  private async sendStopRequest(record: TaskRecord): Promise<void> {
    try {
      await this.hermes.stopRun(record.runId!, {
        signal: this.abortController.signal,
        sessionKey: this.ownerSessionKeys.get(record.ownerId),
      });
      this.confirmedStopRequests.add(record.taskId);
      if (!this.closed) this.schedulePoll(record.taskId, 0);
    } catch (error) {
      if (this.closed && isAbortError(error)) return;
      this.confirmedStopRequests.delete(record.taskId);
      await this.markUnknown(record.taskId, "Hermes stop outcome could not be confirmed.");
      if (!this.closed) this.schedulePoll(record.taskId, this.pollIntervalMs);
    }
  }

  private updateOwnedNotification(
    ownerId: string,
    taskId: string,
    updater: (record: TaskRecord) => TaskRecord,
  ): Promise<TaskRecord> {
    this.assertReady();
    const parsedOwnerId = TaskOwnerIdSchema.parse(ownerId);
    const parsedTaskId = TaskIdSchema.parse(taskId);
    return this.mutatePersist(parsedTaskId, (record) => {
      if (record.ownerId !== parsedOwnerId) throw new TaskNotFoundError(parsedTaskId);
      return updater(record);
    });
  }

  private async requireOwned(ownerId: string, taskId: string): Promise<TaskRecord> {
    const parsedOwnerId = TaskOwnerIdSchema.parse(ownerId);
    const parsedTaskId = TaskIdSchema.parse(taskId);
    const record = await this.store.load(parsedTaskId);
    if (!record || record.ownerId !== parsedOwnerId) throw new TaskNotFoundError(parsedTaskId);
    return record;
  }

  private assertReady(): void {
    this.assertOpen();
    if (!this.initialized) throw new Error("TaskSupervisor.initialize() must complete before use.");
  }

  private assertOpen(): void {
    if (this.closed) throw new TaskSupervisorClosedError();
  }

  // The implementation below owns dispatch, reconciliation, watchers, and
  // persistence. It is intentionally private so callers cannot bypass the
  // owner-scoped public contract above.

  private scheduleDrain(): void {
    if (this.closed || !this.initialized) return;
    if (this.drainRunning) {
      this.drainRequested = true;
      return;
    }
    if (this.drainQueued) return;
    this.drainQueued = true;
    queueMicrotask(() => {
      this.drainQueued = false;
      if (this.closed) return;
      this.trackBackground(this.performDrain().catch((error) => this.reportError(error)));
    });
  }

  private async performDrain(): Promise<void> {
    if (this.drainRunning) {
      this.drainRequested = true;
      return;
    }
    this.drainRunning = true;
    try {
      do {
        this.drainRequested = false;
        while (!this.closed) {
          const admitted = await this.admitNextTask();
          if (!admitted) break;
          this.trackBackground(this.dispatchTask(admitted).catch((error) => this.reportError(error)));
        }
      } while (this.drainRequested && !this.closed);
    } finally {
      this.drainRunning = false;
    }
  }

  private admitNextTask(): Promise<TaskRecord | undefined> {
    return this.serialized(async () => {
      const records = await this.store.list();
      // A 404-proven missing run cannot still consume Hermes capacity. Every
      // other unknown outcome remains an admission fence: especially
      // dispatch_unknown, because retrying or admitting an exclusive peer could
      // duplicate an already-running mutation without upstream idempotency.
      const active = records.filter((record) =>
        ACTIVE_TASK_STATUSES.has(record.status)
        && !(record.status === "unknown" && this.confirmedMissing.has(record.taskId)));
      if (active.length >= this.maxConcurrent) return undefined;
      const now = this.now();
      const queued = records
        .filter((record) => record.status === "queued")
        .sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId));
      for (const candidate of queued) {
        if (!this.ownerSessionKeys.has(candidate.ownerId)) continue;
        if ((this.retryNotBefore.get(candidate.taskId) ?? 0) > now) continue;
        if (!canAdmit(candidate, active)) {
          // An exclusive task is a FIFO barrier so it cannot be starved by a
          // stream of later reads. A read blocked only by an overlapping key
          // does not need to head-of-line block later disjoint read-only work.
          if (candidate.executionMode === "exclusive") return undefined;
          continue;
        }
        const updated = await this.store.update(
          candidate.taskId,
          (current) => transitionTask(current, "dispatching", { now, summary: "Dispatching task to Hermes." }),
          { expectedRevision: candidate.revision },
        );
        this.publish(updated);
        return updated;
      }
      return undefined;
    });
  }

  private async dispatchTask(task: TaskRecord): Promise<void> {
    const sessionKey = this.ownerSessionKeys.get(task.ownerId);
    if (!sessionKey) {
      await this.transitionPersist(task.taskId, "queued", { summary: "Task is waiting for its owner to reconnect." });
      return;
    }
    try {
      const started = await this.hermes.startRun({
        input: task.input,
        sessionId: task.hermesSessionId,
        sessionKey,
        ...(this.runInstructions ? { instructions: this.runInstructions } : {}),
      }, this.abortController.signal);
      const running = await this.transitionPersist(task.taskId, "running", {
        runId: started.runId,
        summary: "Hermes accepted the task.",
      });
      this.retryAttempts.delete(task.taskId);
      this.retryNotBefore.delete(task.taskId);
      if (!this.closed && running.stopRequestedAt !== undefined) {
        await this.requestStop(running, "Stop requested during dispatch.");
      } else if (!this.closed) {
        this.startWatcher(running);
      }
    } catch (error) {
      const status = httpStatus(error);
      const current = await this.store.load(task.taskId);
      const stopRequested = current?.stopRequestedAt !== undefined;
      if (stopRequested && (
        isDefinitiveRetryableDispatchRejection(error)
        || isDefinitiveClientDispatchRejection(error)
      )) {
        await this.transitionPersist(task.taskId, "cancelled", {
          summary: "Task cancelled before Hermes admitted it.",
        });
        this.scheduleDrain();
        return;
      }
      if (isDefinitiveRetryableDispatchRejection(error)) {
        await this.transitionPersist(task.taskId, "queued", {
          summary: "Hermes is busy; task safely requeued.",
        });
        const attempt = (this.retryAttempts.get(task.taskId) ?? 0) + 1;
        this.retryAttempts.set(task.taskId, attempt);
        const delay = Math.min(this.retryBaseMs * (2 ** Math.min(attempt - 1, 20)), this.retryMaxMs);
        this.retryNotBefore.set(task.taskId, this.now() + delay);
        this.scheduleTimer(`retry:${task.taskId}`, delay, () => {
          this.retryNotBefore.delete(task.taskId);
          this.scheduleDrain();
        });
        this.scheduleDrain();
        return;
      }
      if (isDefinitiveClientDispatchRejection(error)) {
        await this.transitionPersist(task.taskId, "failed", {
          error: `Hermes rejected task dispatch with HTTP ${status!}.`,
          summary: "Hermes rejected task dispatch.",
        });
        this.scheduleDrain();
        return;
      }
      await this.transitionPersist(task.taskId, "dispatch_unknown", {
        summary: "Hermes dispatch outcome could not be confirmed; automatic retry is disabled.",
      });
    }
  }

  private startWatcher(record: TaskRecord): void {
    if (
      this.closed
      || !record.runId
      || isTaskTerminal(record.status)
      || this.watching.has(record.taskId)
      || this.pollSuppressed.has(record.taskId)
    ) return;
    this.watching.add(record.taskId);
    this.schedulePoll(record.taskId, this.pollIntervalMs);
    this.trackBackground(this.consumeRunEvents(record)
      .catch((error) => {
        if (!this.closed && !isAbortError(error)) this.reportError(error);
      })
      .finally(() => this.watching.delete(record.taskId)));
  }

  private async consumeRunEvents(record: TaskRecord): Promise<void> {
    try {
      const events = this.hermes.streamRunEvents(record.runId!, {
        signal: this.abortController.signal,
        sessionKey: this.ownerSessionKeys.get(record.ownerId),
      });
      for await (const event of events) {
        if (this.closed) return;
        await this.handleRunEvent(record.taskId, record.runId!, event);
        const current = await this.store.load(record.taskId);
        if (!current || isTaskTerminal(current.status)) return;
      }
    } finally {
      if (!this.closed) {
        await this.reconcileTask(record.taskId);
        const current = await this.store.load(record.taskId);
        if (current?.runId && !isTaskTerminal(current.status)) this.schedulePoll(record.taskId, this.pollIntervalMs);
      }
    }
  }

  private async handleRunEvent(taskId: string, runId: string, event: HermesRunEvent): Promise<void> {
    if (event.run_id !== undefined && event.run_id !== runId) {
      await this.markUnknown(taskId, "Hermes sent an event for a different run.");
      throw new Error("Hermes run-event correlation mismatch.");
    }
    switch (event.event) {
      case "run.started":
      case "run.queued":
        await this.applySnapshot(taskId, { object: "hermes.run", run_id: runId, status: "running" });
        return;
      case "run.stopping":
        await this.applySnapshot(taskId, { object: "hermes.run", run_id: runId, status: "stopping" });
        return;
      case "run.completed":
      {
        const output = typeof event.output === "string" ? event.output : "";
        await this.applySnapshot(taskId, {
          object: "hermes.run",
          run_id: runId,
          status: "completed",
          output,
          outputTruncated: output.length > MAX_TASK_OUTPUT_CHARS,
          usage: normalizeHermesUsage(event.usage),
        });
        return;
      }
      case "run.failed":
        await this.applySnapshot(taskId, {
          object: "hermes.run",
          run_id: runId,
          status: "failed",
          error: "Hermes run failed.",
        });
        return;
      case "run.cancelled":
        await this.applySnapshot(taskId, { object: "hermes.run", run_id: runId, status: "cancelled" });
        return;
      case "approval.request":
        await this.handleApprovalRequest(taskId, runId, event);
        return;
      case "tool.started":
        await this.appendBoundedProgress(taskId, "Hermes started a tool.");
        return;
      case "tool.completed":
        await this.appendBoundedProgress(taskId, "Hermes completed a tool.");
        return;
      default:
        // Deltas, reasoning, raw tool payloads, and unknown event fields are
        // deliberately ignored; they never become durable notifications.
    }
  }

  private async handleApprovalRequest(taskId: string, runId: string, event: HermesRunEvent): Promise<void> {
    const waiting = await this.moveToStatus(taskId, "waiting_for_approval", {
      summary: "Task requires approval.",
    });
    if (isTaskTerminal(waiting.status)) return;
    // v0.5 has no user-facing targeted-approval response path. Even an opaque
    // id in an upstream event is therefore not actionable here: every approval
    // is denied-all and the exact run is stopped fail-closed.
    await this.containUncorrelatedApproval(waiting, runId);
  }

  private async containUncorrelatedApproval(waiting: TaskRecord, runId: string): Promise<void> {
    const taskId = waiting.taskId;
    if (
      this.containingApprovals.has(taskId)
      || this.closed
      || isTaskTerminal(waiting.status)
    ) return;
    this.containingApprovals.add(taskId);
    try {
      try {
        await this.hermes.submitApproval(runId, "deny", {
          resolveAll: true,
          signal: this.abortController.signal,
          sessionKey: this.ownerSessionKeys.get(waiting.ownerId),
        });
      } catch (error) {
        if (!this.closed && !isAbortError(error)) this.reportError(error);
      }
      if (!this.closed) {
        const current = await this.requireTask(taskId);
        if (!isTaskTerminal(current.status)) {
          await this.requestStop(current, "Uncorrelated approval denied fail-closed.");
        }
      }
    } finally {
      this.containingApprovals.delete(taskId);
    }
  }

  private async appendBoundedProgress(taskId: string, summary: string): Promise<void> {
    const count = this.progressEventCounts.get(taskId) ?? 0;
    if (count >= MAX_PROGRESS_EVENTS_PER_TASK) return;
    const updated = await this.mutatePersist(taskId, (record) => {
      if (isTaskTerminal(record.status)) return record;
      return appendTaskEvent(record, { summary, now: this.now() });
    });
    if (!isTaskTerminal(updated.status)) this.progressEventCounts.set(taskId, count + 1);
  }

  private async reconcileTask(taskId: string): Promise<void> {
    const record = await this.store.load(taskId);
    if (!record?.runId || isTaskTerminal(record.status) || this.closed) return;
    try {
      const snapshot = await this.hermes.getRun(record.runId, {
        signal: this.abortController.signal,
        sessionKey: this.ownerSessionKeys.get(record.ownerId),
      });
      if (snapshot.run_id !== record.runId) {
        this.pollSuppressed.add(taskId);
        await this.markUnknown(taskId, "Hermes returned a snapshot for a different run.");
        return;
      }
      this.pollSuppressed.delete(taskId);
      this.confirmedMissing.delete(taskId);
      await this.applySnapshot(taskId, snapshot);
    } catch (error) {
      if (this.closed && isAbortError(error)) return;
      if (httpStatus(error) === 404) {
        this.pollSuppressed.add(taskId);
        this.confirmedMissing.add(taskId);
        await this.markUnknown(taskId, "Hermes no longer recognizes this run.");
      } else if (!isAbortError(error)) {
        this.reportError(error);
      }
    }
  }

  private async applySnapshot(taskId: string, snapshot: HermesRunSnapshot): Promise<TaskRecord> {
    switch (snapshot.status) {
      case "queued":
      case "running":
      {
        const current = await this.requireTask(taskId);
        if (current.stopRequestedAt !== undefined && current.runId) {
          // A successful exact-stop request already moved the durable record to
          // stopping. Hermes may briefly report its prior running snapshot while
          // applying that request; do not turn normal polling into duplicate
          // stop traffic. Unknown means the stop response itself was ambiguous,
          // while running here means dispatch completed after the user stopped.
          if (current.status === "stopping" && this.confirmedStopRequests.has(current.taskId)) return current;
          return this.requestStop(current, "Retrying the persisted exact task stop.");
        }
        return this.moveToStatus(taskId, "running", { summary: "Task is running in Hermes." });
      }
      case "waiting_for_approval":
      {
        const waiting = await this.moveToStatus(taskId, "waiting_for_approval", { summary: "Task requires approval." });
        await this.containUncorrelatedApproval(waiting, snapshot.run_id);
        return (await this.store.load(taskId)) ?? waiting;
      }
      case "stopping":
        return this.moveToStatus(taskId, "stopping", { summary: "Hermes is stopping the task." });
      case "completed": {
        const completed = await this.moveToStatus(taskId, "completed", {
          output: snapshot.output,
          outputTruncated: snapshot.outputTruncated === true,
          usage: snapshot.usage,
          summary: "Task completed.",
        });
        this.confirmedStopRequests.delete(taskId);
        this.scheduleDrain();
        return completed;
      }
      case "failed": {
        const failed = await this.moveToStatus(taskId, "failed", {
          error: "Hermes run failed.",
          summary: "Task failed.",
        });
        this.confirmedStopRequests.delete(taskId);
        this.scheduleDrain();
        return failed;
      }
      case "cancelled": {
        const cancelled = await this.moveToStatus(taskId, "cancelled", { summary: "Task cancelled." });
        this.confirmedStopRequests.delete(taskId);
        this.scheduleDrain();
        return cancelled;
      }
    }
  }

  private async moveToStatus(
    taskId: string,
    target: TaskStatus,
    options: TaskTransitionOptions = {},
  ): Promise<TaskRecord> {
    let current = await this.requireTask(taskId);
    if (current.status === target || isTaskTerminal(current.status)) return current;
    if (target === "running") {
      if (current.status === "queued") current = await this.transitionPersist(taskId, "dispatching");
      if (["dispatching", "unknown", "dispatch_unknown", "waiting_for_approval"].includes(current.status)) {
        return this.transitionPersist(taskId, "running", options);
      }
      return current;
    }
    if (["waiting_for_approval", "stopping", "completed", "failed", "cancelled"].includes(target)) {
      if (current.status === "queued") current = await this.transitionPersist(taskId, "dispatching");
      if (current.status === "dispatching" && target !== "failed" && target !== "cancelled") {
        current = await this.transitionPersist(taskId, "running");
      }
      if (current.status === "dispatch_unknown" && target === "waiting_for_approval") {
        current = await this.transitionPersist(taskId, "running");
      }
      if (canTransitionTask(current.status, target)) return this.transitionPersist(taskId, target, options);
    }
    return current;
  }

  private markUnknown(taskId: string, summary: string): Promise<TaskRecord> {
    return this.mutatePersist(taskId, (record) => {
      if (isTaskTerminal(record.status) || record.status === "unknown") return record;
      if (record.status === "dispatching" && !record.runId) {
        return transitionTask(record, "dispatch_unknown", { now: this.now(), summary });
      }
      if (!canTransitionTask(record.status, "unknown")) return record;
      return transitionTask(record, "unknown", { now: this.now(), summary });
    });
  }

  private transitionPersist(
    taskId: string,
    status: TaskStatus,
    options: TaskTransitionOptions = {},
  ): Promise<TaskRecord> {
    return this.mutatePersist(taskId, (record) => {
      if (record.status === status || isTaskTerminal(record.status)) return record;
      if (!canTransitionTask(record.status, status)) return record;
      return transitionTask(record, status, { ...options, now: options.now ?? this.now() });
    });
  }

  private mutatePersist(taskId: string, updater: (record: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    return this.serialized(async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = await this.store.load(taskId);
        if (!current) throw new TaskNotFoundError(taskId);
        const updated = updater(current);
        if (updated.revision === current.revision) return cloneTask(current);
        try {
          const persisted = await this.store.update(taskId, () => updated, { expectedRevision: current.revision });
          this.publish(persisted);
          return persisted;
        } catch (error) {
          if (errorName(error) !== "TaskStoreConflictError" || attempt === 3) throw error;
        }
      }
      throw new Error("Task update retry loop exhausted.");
    });
  }

  private requireTask(taskId: string): Promise<TaskRecord> {
    return this.store.load(TaskIdSchema.parse(taskId)).then((record) => {
      if (!record) throw new TaskNotFoundError(taskId);
      return record;
    });
  }

  private schedulePoll(taskId: string, delayMs: number): void {
    if (this.pollSuppressed.has(taskId)) return;
    this.scheduleTimer(`poll:${taskId}`, delayMs, () => {
      this.trackBackground(this.pollTask(taskId).catch((error) => this.reportError(error)));
    });
  }

  private async pollTask(taskId: string): Promise<void> {
    await this.reconcileTask(taskId);
    const current = await this.store.load(taskId);
    if (!current || isTaskTerminal(current.status)) {
      this.scheduleDrain();
      return;
    }
    if (current.runId && !this.pollSuppressed.has(taskId)) this.schedulePoll(taskId, this.pollIntervalMs);
  }

  private scheduleTimer(key: string, delayMs: number, callback: () => void): void {
    if (this.closed) return;
    const existing = this.timers.get(key);
    if (existing !== undefined) this.scheduler.clearTimeout(existing);
    const handle = this.scheduler.setTimeout(() => {
      this.timers.delete(key);
      if (!this.closed) callback();
    }, Math.max(0, delayMs));
    this.timers.set(key, handle);
  }

  private publish(record: TaskRecord): void {
    if (this.closed) return;
    const listeners = this.subscribers.get(record.ownerId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(cloneTask(record));
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Error observers cannot destabilize the supervisor.
    }
  }

  private trackBackground(operation: Promise<void>): void {
    this.backgroundOperations.add(operation);
    void operation.finally(() => this.backgroundOperations.delete(operation)).catch(() => undefined);
  }

  private nextCreationTimestamp(): number {
    const observed = this.now();
    const timestamp = this.lastCreatedAt === undefined ? observed : Math.max(observed, this.lastCreatedAt + 1);
    this.lastCreatedAt = timestamp;
    return timestamp;
  }
}

const defaultScheduler: TaskSupervisorScheduler = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function canAdmit(candidate: TaskRecord, active: readonly TaskRecord[]): boolean {
  if (active.length === 0) return true;
  if (candidate.executionMode !== "parallel_read_only") return false;
  return active.every((record) =>
    record.executionMode === "parallel_read_only"
    && resourcesAreDisjoint(candidate.resourceKeys, record.resourceKeys));
}

function validateSessionKey(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Hermes session key must be a safe non-empty value of at most 1024 characters.");
  }
  return value;
}

function normalizeHermesUsage(value: unknown): { input_tokens: number; output_tokens: number; total_tokens: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }
  const source = value as Record<string, unknown>;
  return {
    input_tokens: nonNegativeNumber(source.input_tokens),
    output_tokens: nonNegativeNumber(source.output_tokens),
    total_tokens: nonNegativeNumber(source.total_tokens),
  };
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

function httpStatus(error: unknown): number | undefined {
  if (error && typeof error === "object") {
    for (const key of ["status", "statusCode"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    }
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === "object") {
      const value = (response as { status?: unknown }).status;
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    }
  }
  return undefined;
}

function isDefinitiveRetryableDispatchRejection(error: unknown): boolean {
  const status = httpStatus(error);
  const code = structuredHermesErrorCode(error);
  return (status === 429 && code === "rate_limit_exceeded")
    || (status === 503 && code === "gateway_draining");
}

function isDefinitiveClientDispatchRejection(error: unknown): boolean {
  const status = httpStatus(error);
  if (status === undefined || status < 400 || status >= 500) return false;
  // These statuses can describe a request whose processing outcome is not
  // known. A 429 is safe only with Hermes' explicit pre-admission code above.
  return status !== 408 && status !== 425 && status !== 429;
}

function structuredHermesErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  for (const key of ["errorCode", "code"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string" && /^[a-z][a-z0-9_.-]{0,127}$/u.test(value)) return value;
  }
  return undefined;
}

function resourcesAreDisjoint(left: readonly string[], right: readonly string[]): boolean {
  const rightKeys = new Set(right);
  return left.every((key) => !rightKeys.has(key));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /\babort(?:ed)?\b/iu.test(error.message));
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function cloneTask(record: TaskRecord): TaskRecord {
  return structuredClone(record);
}
