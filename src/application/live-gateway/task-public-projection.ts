import type { TaskEvent, TaskRecord, TaskStatus } from "../../domain/tasks/index.js";
import type {
  PublicTaskError,
  PublicTaskSnapshot,
  ServerMessage,
  TaskNotification,
} from "../../domain/protocol/server-protocol.js";

const PUBLIC_TITLE_CHARS = 200;
const PUBLIC_PROGRESS_CHARS = 1_000;
const PUBLIC_SUMMARY_CHARS = 4_000;

export interface ProjectTaskOptions {
  includeOutput?: boolean;
}

export function projectTaskSnapshot(record: TaskRecord, options: ProjectTaskOptions = {}): PublicTaskSnapshot {
  const state = publicTaskState(record);
  const startedAt = firstEventTimestamp(record, ["dispatching", "running"]);
  const finishedAt = firstEventTimestamp(record, ["completed", "failed", "cancelled"]);
  const snapshot: PublicTaskSnapshot = {
    taskId: record.taskId,
    kind: record.kind ?? "background",
    ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
    rootTaskId: record.rootTaskId ?? record.taskId,
    sequence: record.sequence,
    state,
    title: record.title.slice(0, PUBLIC_TITLE_CHARS),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };

  if (state === "completed") {
    snapshot.result = {
      summary: summarizeOutput(record.output),
      ...(options.includeOutput && record.output !== undefined ? { output: record.output } : {}),
      truncated: record.outputTruncated === true
        || (record.output !== undefined && options.includeOutput !== true),
      ...(record.usage ? { usage: record.usage } : {}),
    };
  } else if (state === "failed" || state === "unknown") {
    snapshot.error = publicTaskError(record);
  } else if (state === "running" || state === "stopping") {
    const summary = latestProgressSummary(record);
    if (summary) snapshot.progress = { message: summary };
  }

  return snapshot;
}

export function projectTaskLifecycle(record: TaskRecord, requestId?: string): ServerMessage {
  const base = {
    taskId: record.taskId,
    sequence: record.sequence,
    occurredAt: record.updatedAt,
  };
  const summary = latestProgressSummary(record) ?? "Task updated.";
  if (
    record.stopRequestedAt !== undefined
    && publicTaskState(record) === "stopping"
    && record.status !== "stopping"
  ) {
    return {
      type: "task.stopping",
      ...base,
      ...(requestId ? { requestId } : {}),
      reason: summary.slice(0, 1_000),
    };
  }
  switch (record.status) {
    case "queued":
      return {
        type: "task.accepted",
        ...base,
        ...(requestId ? { requestId } : {}),
        state: "queued",
        title: record.title.slice(0, PUBLIC_TITLE_CHARS),
        kind: record.kind ?? "background",
        ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
        rootTaskId: record.rootTaskId ?? record.taskId,
      };
    case "dispatching":
      return {
        type: "task.accepted",
        ...base,
        ...(requestId ? { requestId } : {}),
        state: "accepted",
        title: record.title.slice(0, PUBLIC_TITLE_CHARS),
        kind: record.kind ?? "background",
        ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
        rootTaskId: record.rootTaskId ?? record.taskId,
      };
    case "running":
      return record.events.at(-1)?.type === "progress"
        ? { type: "task.progress", ...base, progress: { message: summary } }
        : { type: "task.started", ...base, title: record.title.slice(0, PUBLIC_TITLE_CHARS) };
    case "waiting_for_approval":
      // Current Hermes releases cannot target approval responses safely. The
      // supervisor immediately contains these runs, so clients receive a
      // progress fact rather than an actionable approval with invented identity.
      return { type: "task.progress", ...base, progress: { message: summary } };
    case "stopping":
      return {
        type: "task.stopping",
        ...base,
        ...(requestId ? { requestId } : {}),
        reason: summary.slice(0, 1_000),
      };
    case "completed":
      return {
        type: "task.completed",
        ...base,
        ...(requestId ? { requestId } : {}),
        result: {
          summary: summarizeOutput(record.output),
          ...(record.output !== undefined ? { output: record.output } : {}),
          truncated: record.outputTruncated === true,
          ...(record.usage ? { usage: record.usage } : {}),
        },
      };
    case "failed":
      return {
        type: "task.failed",
        ...base,
        ...(requestId ? { requestId } : {}),
        error: publicTaskError(record),
      };
    case "cancelled":
      return {
        type: "task.cancelled",
        ...base,
        ...(requestId ? { requestId } : {}),
        reason: summary.slice(0, 1_000),
      };
    case "unknown":
    case "dispatch_unknown":
      return {
        type: "task.unknown",
        ...base,
        ...(requestId ? { requestId } : {}),
        error: publicTaskError(record),
      };
  }
}

export function projectTaskNotification(record: TaskRecord): TaskNotification | undefined {
  const kind = notificationKind(record.status);
  if (!kind) return undefined;
  const anchor = notificationAnchor(record);
  return {
    notificationId: notificationIdForTask(record),
    kind,
    delivery: "when_idle",
    message: notificationMessage(record, kind),
    createdAt: anchor.timestamp,
    acknowledged: !record.notification.unread,
  };
}

/**
 * Withdraw a previously projected notice when an uncertain task re-enters a
 * non-notifiable recovery state. Reconnects do not need this projection because
 * the durable unread bit is already clear; it exists for connected clients
 * that still hold the old notification identity.
 */
export function projectSupersededTaskNotification(record: TaskRecord): TaskNotification | undefined {
  if (notificationKind(record.status) || record.notification.unread) return undefined;
  const anchor = [...record.events].reverse().find((event) => notificationKindFromEvent(event.type));
  if (!anchor) return undefined;
  const kind = notificationKindFromEvent(anchor.type);
  if (!kind) return undefined;
  return {
    notificationId: notificationId(record.taskId, anchor.sequence),
    kind,
    delivery: "when_idle",
    message: notificationMessage(record, kind),
    createdAt: anchor.timestamp,
    acknowledged: true,
  };
}

export function notificationIdForTask(
  record: Pick<TaskRecord, "taskId" | "sequence" | "status" | "events" | "operatorContainedAt">,
): string {
  return notificationId(record.taskId, notificationAnchor(record).sequence);
}

export function isTaskNotificationState(status: TaskStatus): boolean {
  return notificationKind(status) !== undefined;
}

function publicTaskState(record: TaskRecord): PublicTaskSnapshot["state"] {
  if (
    record.stopRequestedAt !== undefined
    && !["completed", "failed", "cancelled", "unknown", "dispatch_unknown"].includes(record.status)
  ) {
    return "stopping";
  }
  switch (record.status) {
    case "dispatching":
      return "accepted";
    case "waiting_for_approval":
      // The public protocol has no interactive approval surface: current Hermes
      // cannot prove that a response targets exactly one queued approval. The
      // supervisor denies all pending approvals and stops this run fail-closed.
      return "stopping";
    case "dispatch_unknown":
      return "unknown";
    default:
      return record.status;
  }
}

function publicTaskError(record: TaskRecord): PublicTaskError {
  if (record.status === "dispatch_unknown") {
    return {
      code: "task_dispatch_unknown",
      message: record.operatorContainedAt === undefined
        ? "Hermes may have accepted this task, but no run id was confirmed. It was not retried."
        : "The outcome is still unknown. An operator confirmed the task was contained and unblocked new work.",
      recoverable: false,
    };
  }
  if (record.status === "unknown") {
    return {
      code: "task_state_unknown",
      message: record.operatorContainedAt === undefined
        ? "Hermes Live cannot prove this task's outcome."
        : "The outcome is still unknown. An operator confirmed the task was contained and unblocked new work.",
      recoverable: false,
    };
  }
  return {
    code: "task_failed",
    message: "Hermes reported that the background task failed.",
    recoverable: false,
  };
}

function summarizeOutput(output: string | undefined): string {
  const normalized = output?.replace(/\s+/gu, " ").trim();
  return (normalized || "Task completed.").slice(0, PUBLIC_SUMMARY_CHARS);
}

function latestProgressSummary(record: TaskRecord): string | undefined {
  const summary = record.events.at(-1)?.summary?.trim();
  return summary ? summary.slice(0, PUBLIC_PROGRESS_CHARS) : undefined;
}

function firstEventTimestamp(record: TaskRecord, types: readonly string[]): number | undefined {
  return record.events.find((event) => types.includes(event.type))?.timestamp;
}

function notificationKind(status: TaskStatus): TaskNotification["kind"] | undefined {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
      return status;
    case "unknown":
    case "dispatch_unknown":
      return "unknown";
    default:
      return undefined;
  }
}

function notificationKindFromEvent(type: TaskEvent["type"]): TaskNotification["kind"] | undefined {
  switch (type) {
    case "completed":
    case "failed":
    case "cancelled":
      return type;
    case "unknown":
    case "dispatch_unknown":
    case "operator_contained":
      return "unknown";
    default:
      return undefined;
  }
}

function notificationId(taskId: string, sequence: number): string {
  return `notification_${taskId}_${sequence}`;
}

function notificationAnchor(
  record: Pick<TaskRecord, "sequence" | "status" | "events" | "operatorContainedAt">,
): { sequence: number; timestamp: number } {
  const expectedType = record.operatorContainedAt === undefined ? record.status : "operator_contained";
  const event = [...record.events].reverse().find((candidate) => candidate.type === expectedType);
  return event ?? {
    sequence: record.sequence,
    timestamp: record.events.at(-1)?.timestamp ?? 0,
  };
}

function notificationMessage(record: TaskRecord, kind: TaskNotification["kind"]): string {
  const title = record.title.slice(0, PUBLIC_TITLE_CHARS);
  switch (kind) {
    case "completed":
      return `“${title}” completed.`;
    case "failed":
      return `“${title}” failed.`;
    case "cancelled":
      return `“${title}” was cancelled.`;
    case "unknown":
      return `The outcome of “${title}” cannot be proven.`;
  }
}
