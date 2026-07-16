import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const TASK_RECORD_SCHEMA_VERSION = 1 as const;
export const MAX_TASK_TITLE_CHARS = 256;
export const MAX_TASK_INPUT_CHARS = 100_000;
export const MAX_TASK_OUTPUT_CHARS = 200_000;
export const MAX_TASK_ERROR_CHARS = 4_000;
export const MAX_TASK_EVENT_SUMMARY_CHARS = 2_000;
export const MAX_TASK_EVENTS = 128;
export const MAX_TASK_RESOURCE_KEYS = 16;
export const MAX_TASK_RESOURCE_KEY_CHARS = 256;
export const MAX_TASK_USAGE_FIELDS = 32;

const UNSAFE_SINGLE_LINE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_SINGLE_LINE_CHARS_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/gu;
const UNSAFE_MULTILINE_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const UNSAFE_MULTILINE_CONTROL_CHARS_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

export const TaskIdSchema = z.string().regex(
  /^task_[0-9a-f]{32}$/u,
  "Task ID must use the task_<32 lowercase hex> format.",
);
export const TaskOwnerIdSchema = z.string().regex(/^owner_[0-9a-f]{64}$/u, "Task owner ID must be a SHA-256 hash.");
export const TaskRunIdSchema = z.string().min(1).max(256).refine(isSafeSingleLine, "Run ID contains unsafe characters.");
export const TaskHermesSessionIdSchema = z.string().min(1).max(256).refine(
  isSafeSingleLine,
  "Hermes session ID contains unsafe characters.",
);
const TaskTitleSchema = z.string().min(1).max(MAX_TASK_TITLE_CHARS).refine(
  isSafeSingleLine,
  "Task title contains unsafe characters.",
);
const TaskInputSchema = z.string().min(1).max(MAX_TASK_INPUT_CHARS).refine(
  isSafeMultiline,
  "Task input contains unsafe control characters.",
);
const TaskOutputSchema = z.string().max(MAX_TASK_OUTPUT_CHARS).refine(
  isSafeMultiline,
  "Task output contains unsafe control characters.",
);
const TaskErrorSchema = z.string().min(1).max(MAX_TASK_ERROR_CHARS).refine(
  isSafeMultiline,
  "Task error contains unsafe control characters.",
);
export const TaskResourceKeySchema = z.string().min(1).max(MAX_TASK_RESOURCE_KEY_CHARS).refine(
  isSafeSingleLine,
  "Task resource key contains unsafe characters.",
);
const TaskTimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TaskCounterSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const TaskUsageKeySchema = z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/u);
const TaskUsageValueSchema = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const TaskStatusSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "waiting_for_approval",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "unknown",
  "dispatch_unknown",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskExecutionModeSchema = z.enum(["exclusive", "parallel_read_only"]);
export type TaskExecutionMode = z.infer<typeof TaskExecutionModeSchema>;

export const TaskEventTypeSchema = z.enum([
  ...TaskStatusSchema.options,
  "progress",
  "stop_requested",
  "approval_required",
  "notification.announced",
  "notification.acknowledged",
  "operator_contained",
]);
export type TaskEventType = z.infer<typeof TaskEventTypeSchema>;

export const TaskUsageSchema = z.record(TaskUsageKeySchema, TaskUsageValueSchema).superRefine((value, context) => {
  if (Object.keys(value).length > MAX_TASK_USAGE_FIELDS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Task usage exceeds ${MAX_TASK_USAGE_FIELDS} fields.`,
    });
  }
});
export type TaskUsage = z.infer<typeof TaskUsageSchema>;

export const TaskEventSchema = z.object({
  sequence: TaskCounterSchema,
  type: TaskEventTypeSchema,
  timestamp: TaskTimestampSchema,
  summary: z.string().min(1).max(MAX_TASK_EVENT_SUMMARY_CHARS).refine(
    isSafeSingleLine,
    "Task event summary contains unsafe characters.",
  ).optional(),
}).strict();
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const TaskNotificationSchema = z.object({
  unread: z.boolean(),
  announcedAt: TaskTimestampSchema.optional(),
  acknowledgedAt: TaskTimestampSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.unread && value.acknowledgedAt !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An acknowledged task notification cannot remain unread.",
    });
  }
});
export type TaskNotification = z.infer<typeof TaskNotificationSchema>;

export const TaskRecordSchema = z.object({
  schemaVersion: z.literal(TASK_RECORD_SCHEMA_VERSION),
  taskId: TaskIdSchema,
  ownerId: TaskOwnerIdSchema,
  input: TaskInputSchema,
  title: TaskTitleSchema,
  hermesSessionId: TaskHermesSessionIdSchema,
  runId: TaskRunIdSchema.optional(),
  executionMode: TaskExecutionModeSchema,
  resourceKeys: z.array(TaskResourceKeySchema).min(1).max(MAX_TASK_RESOURCE_KEYS),
  status: TaskStatusSchema,
  createdAt: TaskTimestampSchema,
  updatedAt: TaskTimestampSchema,
  revision: TaskCounterSchema,
  sequence: TaskCounterSchema,
  events: z.array(TaskEventSchema).min(1).max(MAX_TASK_EVENTS),
  stopRequestedAt: TaskTimestampSchema.optional(),
  upstreamRunMissingAt: TaskTimestampSchema.optional(),
  operatorContainedAt: TaskTimestampSchema.optional(),
  output: TaskOutputSchema.optional(),
  outputTruncated: z.boolean().optional(),
  usage: TaskUsageSchema.optional(),
  error: TaskErrorSchema.optional(),
  notification: TaskNotificationSchema,
}).strict().superRefine((record, context) => {
  if (record.updatedAt < record.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Task updatedAt precedes createdAt." });
  }
  if (record.hermesSessionId !== hermesSessionIdForTask(record.taskId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Task Hermes session ID does not match its task ID." });
  }
  if (new Set(record.resourceKeys).size !== record.resourceKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Task resource keys must be unique." });
  }
  let previousSequence = 0;
  let previousTimestamp = 0;
  for (const event of record.events) {
    if (event.sequence <= previousSequence || event.sequence > record.sequence) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Task event sequences must be ordered and bounded." });
      break;
    }
    if (event.timestamp < previousTimestamp || event.timestamp > record.updatedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Task event timestamps must be ordered and bounded." });
      break;
    }
    previousSequence = event.sequence;
    previousTimestamp = event.timestamp;
  }
  if (record.events.at(-1)?.sequence !== record.sequence) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Task sequence must match the latest retained event." });
  }
  if (record.events.at(-1)?.timestamp !== record.updatedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Task updatedAt must match the latest retained event." });
  }
  if (
    record.stopRequestedAt !== undefined
    && (record.stopRequestedAt < record.createdAt || record.stopRequestedAt > record.updatedAt)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Task stop intent timestamp must fall within task lifetime." });
  }
  if (record.upstreamRunMissingAt !== undefined) {
    if (
      record.status !== "unknown"
      || record.runId === undefined
      || record.upstreamRunMissingAt < record.createdAt
      || record.upstreamRunMissingAt > record.updatedAt
      || !record.events.some((event) =>
        event.type === "unknown" && event.timestamp === record.upstreamRunMissingAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A confirmed missing upstream run must be an unknown task with a run ID and bounded timestamp.",
      });
    }
  }
  if (record.operatorContainedAt !== undefined) {
    if (
      (record.status !== "unknown" && record.status !== "dispatch_unknown")
      || record.operatorContainedAt < record.createdAt
      || record.operatorContainedAt > record.updatedAt
      || !record.events.some((event) =>
        event.type === "operator_contained" && event.timestamp === record.operatorContainedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Operator containment must close an indeterminate task with an exact audit event.",
      });
    }
  } else if (record.events.some((event) => event.type === "operator_contained")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Operator containment audit event is missing its timestamp." });
  }
  if (record.outputTruncated !== undefined && record.status !== "completed") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only completed tasks can describe output truncation." });
  }
  if (record.outputTruncated === true && record.output === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Truncated task output must include the retained output prefix." });
  }
  if (["completed", "failed", "cancelled", "unknown", "dispatch_unknown"].includes(record.status)) {
    if (!record.events.some((event) => event.type === record.status)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Notifiable task state requires its retained transition event." });
    }
    if (!record.notification.unread && record.notification.acknowledgedAt === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A read task notification requires an acknowledgement timestamp." });
    }
  }
  for (const timestamp of [record.notification.announcedAt, record.notification.acknowledgedAt]) {
    if (timestamp !== undefined && (timestamp < record.createdAt || timestamp > record.updatedAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Task notification timestamps must fall within task lifetime." });
      break;
    }
  }
  if (
    record.notification.announcedAt !== undefined
    && record.notification.acknowledgedAt !== undefined
    && record.notification.acknowledgedAt < record.notification.announcedAt
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Task notification acknowledgement cannot precede announcement." });
  }
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export interface CreateTaskRecordInput {
  ownerIdentity: string;
  input: string;
  title?: string;
  executionMode?: TaskExecutionMode;
  resourceKeys?: readonly string[];
  now?: number;
  taskId?: string;
}

export function createTaskId(): string {
  return `task_${randomUUID().replaceAll("-", "")}`;
}

export function hashTaskOwnerId(ownerIdentity: string): string {
  const normalized = ownerIdentity.trim();
  if (!normalized || normalized.length > 1_024 || !isSafeSingleLine(normalized)) {
    throw new Error("Task owner identity must be a safe non-empty value of at most 1024 characters.");
  }
  return `owner_${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

export function hermesSessionIdForTask(taskId: string): string {
  const parsedTaskId = TaskIdSchema.parse(taskId);
  return `hermes-live:task:${parsedTaskId}`;
}

export function createTaskRecord(input: CreateTaskRecordInput): TaskRecord {
  const taskId = TaskIdSchema.parse(input.taskId ?? createTaskId());
  const now = parseTaskTimestamp(input.now ?? Date.now(), "Task creation timestamp");
  const taskInput = TaskInputSchema.parse(input.input);
  const title = sanitizeTaskTitle(input.title ?? deriveTaskTitle(taskInput));
  const resourceKeys = normalizeResourceKeys(input.resourceKeys ?? ["workspace:default"]);
  const event: TaskEvent = {
    sequence: 1,
    type: "queued",
    timestamp: now,
    summary: "Task queued.",
  };
  return TaskRecordSchema.parse({
    schemaVersion: TASK_RECORD_SCHEMA_VERSION,
    taskId,
    ownerId: hashTaskOwnerId(input.ownerIdentity),
    input: taskInput,
    title,
    hermesSessionId: hermesSessionIdForTask(taskId),
    executionMode: input.executionMode ?? "exclusive",
    resourceKeys,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    sequence: 1,
    events: [event],
    notification: { unread: false },
  });
}

export function sanitizeTaskTitle(value: string): string {
  const normalized = sanitizeSingleLine(value).slice(0, MAX_TASK_TITLE_CHARS).trim();
  return TaskTitleSchema.parse(normalized || "Background task");
}

export function sanitizeTaskEventSummary(value: string): string {
  const normalized = sanitizeSingleLine(value).slice(0, MAX_TASK_EVENT_SUMMARY_CHARS).trim();
  return normalized || "Task updated.";
}

export function sanitizeTaskOutput(value: string): string {
  return sanitizeMultiline(value).slice(0, MAX_TASK_OUTPUT_CHARS);
}

export function sanitizeTaskError(value: string): string {
  const sanitized = sanitizeMultiline(value).slice(0, MAX_TASK_ERROR_CHARS).trim();
  return TaskErrorSchema.parse(sanitized || "Task failed without an error message.");
}

export function sanitizeTaskUsage(value: unknown): TaskUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sanitized: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (Object.keys(sanitized).length >= MAX_TASK_USAGE_FIELDS) break;
    if (!TaskUsageKeySchema.safeParse(key).success) continue;
    if (!TaskUsageValueSchema.safeParse(rawValue).success) continue;
    sanitized[key] = rawValue as number;
  }
  return Object.keys(sanitized).length > 0 ? TaskUsageSchema.parse(sanitized) : undefined;
}

export function parseTaskRecord(value: unknown): TaskRecord {
  return TaskRecordSchema.parse(value);
}

export function normalizeResourceKeys(values: readonly string[]): string[] {
  if (values.length === 0 || values.length > MAX_TASK_RESOURCE_KEYS) {
    throw new Error(`Task resource keys must contain between 1 and ${MAX_TASK_RESOURCE_KEYS} values.`);
  }
  const normalized = [...new Set(values.map((value) => TaskResourceKeySchema.parse(value)))];
  if (normalized.length === 0) throw new Error("Task requires at least one resource key.");
  return normalized;
}

export function parseTaskTimestamp(value: number, label = "Task timestamp"): number {
  const parsed = TaskTimestampSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must be a non-negative safe integer.`);
  return parsed.data;
}

function deriveTaskTitle(input: string): string {
  const firstLine = input.split(/\r?\n/u).find((line) => line.trim()) ?? input;
  return firstLine.slice(0, 120);
}

function sanitizeSingleLine(value: string): string {
  return String(value)
    .replace(UNSAFE_SINGLE_LINE_CHARS_GLOBAL, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizeMultiline(value: string): string {
  return String(value)
    .replace(/\r\n?/gu, "\n")
    .replace(UNSAFE_MULTILINE_CONTROL_CHARS_GLOBAL, "");
}

function isSafeSingleLine(value: string): boolean {
  return value === value.trim() && !UNSAFE_SINGLE_LINE_CHARS.test(value);
}

function isSafeMultiline(value: string): boolean {
  return !UNSAFE_MULTILINE_CONTROL_CHARS.test(value);
}
