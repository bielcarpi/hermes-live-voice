import { z } from "zod";

import {
  NotificationIdSchema,
  RequestIdSchema,
  TASK_LIST_MAX_LIMIT,
  TaskIdSchema,
  TaskSequenceSchema,
} from "./client-protocol.js";

const PUBLIC_MODEL_MAX_CHARS = 256;
const PUBLIC_MIME_TYPE_MAX_CHARS = 128;
const PUBLIC_TRANSCRIPT_MAX_CHARS = 20_000;
const PUBLIC_TASK_TITLE_MAX_CHARS = 256;
const PUBLIC_TASK_PROGRESS_MAX_CHARS = 1_000;
const PUBLIC_TASK_SUMMARY_MAX_CHARS = 4_000;
const PUBLIC_TASK_OUTPUT_MAX_CHARS = 200_000;
const PUBLIC_TASK_ERROR_MAX_CHARS = 2_000;
const PUBLIC_NOTIFICATION_MAX_CHARS = 1_000;
const PUBLIC_LOG_MAX_CHARS = 2_000;
const PUBLIC_JSON_MAX_CHARS = 64_000;
const PUBLIC_AUDIO_BASE64_MAX_CHARS = 8_000_000;
const PUBLIC_TASK_MAX_RETAINED = 10_000;
const PUBLIC_TASK_MAX_CONCURRENT = 64;
const PUBLIC_CONVERSATION_TITLE_MAX_CHARS = 100;
const PUBLIC_CONVERSATION_PREVIEW_MAX_CHARS = 500;

const PublicIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected an opaque public identifier.");
const PublicTimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveTaskSequenceSchema = TaskSequenceSchema.refine((value) => value > 0, "Task event sequence must be positive.");

const BoundedJsonObjectSchema = z.record(z.unknown()).superRefine((value, context) => {
  try {
    if (JSON.stringify(value).length > PUBLIC_JSON_MAX_CHARS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Public JSON metadata exceeds its size limit." });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Public JSON metadata must be serializable." });
  }
});

export const RealtimeClientCapabilitiesSchema = z
  .object({
    provider: z.enum(["gemini", "openai", "mock"]),
    model: z.string().min(1).max(PUBLIC_MODEL_MAX_CHARS),
    audio: z
      .object({
        input: z
          .object({
            enabled: z.boolean(),
            mimeType: z.string().min(1).max(PUBLIC_MIME_TYPE_MAX_CHARS).optional(),
            recommendedFrameMs: z.number().int().positive().max(1_000).optional(),
          })
          .strict(),
        output: z
          .object({
            enabled: z.boolean(),
            mimeType: z.string().min(1).max(PUBLIC_MIME_TYPE_MAX_CHARS).optional(),
          })
          .strict(),
        turnDetection: z.enum(["disabled", "semantic_vad", "server_vad", "provider", "none"]),
      })
      .strict(),
  })
  .strict();
export type RealtimeClientCapabilities = z.infer<typeof RealtimeClientCapabilitiesSchema>;

export const TaskCapabilitiesSchema = z
  .object({
    scope: z.literal("owner"),
    sequence: z.literal("per_task"),
    reconnect: z.literal("snapshot"),
    durable: z.boolean(),
    parallel: z.boolean(),
    maxConcurrent: z.number().int().positive().max(PUBLIC_TASK_MAX_CONCURRENT),
    maxRetained: z.number().int().positive().max(PUBLIC_TASK_MAX_RETAINED),
    supports: z
      .object({
        list: z.boolean(),
        get: z.boolean(),
        stop: z.boolean(),
        followUp: z.boolean(),
        resume: z.literal(false),
        notificationAck: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type TaskCapabilities = z.infer<typeof TaskCapabilitiesSchema>;

export const PublicTaskStateSchema = z.enum([
  "accepted",
  "queued",
  "running",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export type PublicTaskState = z.infer<typeof PublicTaskStateSchema>;

export const PublicTaskProgressSchema = z
  .object({
    message: z.string().min(1).max(PUBLIC_TASK_PROGRESS_MAX_CHARS),
    stage: z.string().min(1).max(128).optional(),
    current: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    percent: z.number().finite().min(0).max(100).optional(),
  })
  .strict()
  .superRefine((progress, context) => {
    if (progress.current !== undefined && progress.total !== undefined && progress.current > progress.total) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Task progress current cannot exceed total." });
    }
  });
export type PublicTaskProgress = z.infer<typeof PublicTaskProgressSchema>;

export const PublicTaskResultSchema = z
  .object({
    summary: z.string().min(1).max(PUBLIC_TASK_SUMMARY_MAX_CHARS).optional(),
    output: z.string().max(PUBLIC_TASK_OUTPUT_MAX_CHARS).optional(),
    truncated: z.boolean().default(false),
    usage: BoundedJsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.summary === undefined && result.output === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A completed task requires a summary or output." });
    }
  });
export type PublicTaskResult = z.infer<typeof PublicTaskResultSchema>;

export const PublicTaskErrorSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(PUBLIC_TASK_ERROR_MAX_CHARS),
    recoverable: z.boolean().default(false),
  })
  .strict();
export type PublicTaskError = z.infer<typeof PublicTaskErrorSchema>;

export const PublicTaskSnapshotSchema = z
  .object({
    taskId: TaskIdSchema,
    kind: z.enum(["background", "follow_up"]).optional(),
    parentTaskId: TaskIdSchema.optional(),
    rootTaskId: TaskIdSchema.optional(),
    sequence: PositiveTaskSequenceSchema,
    state: PublicTaskStateSchema,
    title: z.string().min(1).max(PUBLIC_TASK_TITLE_MAX_CHARS).optional(),
    createdAt: PublicTimestampSchema,
    updatedAt: PublicTimestampSchema,
    startedAt: PublicTimestampSchema.optional(),
    finishedAt: PublicTimestampSchema.optional(),
    progress: PublicTaskProgressSchema.optional(),
    result: PublicTaskResultSchema.optional(),
    error: PublicTaskErrorSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.state === "completed" && snapshot.result === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A completed task requires a public result." });
    }
    if ((snapshot.state === "failed" || snapshot.state === "unknown") && snapshot.error === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${snapshot.state} tasks require a public error.` });
    }
  });
export type PublicTaskSnapshot = z.infer<typeof PublicTaskSnapshotSchema>;

export const TaskNotificationSchema = z
  .object({
    notificationId: NotificationIdSchema,
    kind: z.enum(["completed", "failed", "cancelled", "unknown"]),
    delivery: z.enum(["interrupt", "when_idle", "silent"]),
    message: z.string().min(1).max(PUBLIC_NOTIFICATION_MAX_CHARS),
    createdAt: PublicTimestampSchema,
    acknowledged: z.boolean(),
  })
  .strict();
export type TaskNotification = z.infer<typeof TaskNotificationSchema>;

export const PublicConversationSchema = z
  .object({
    mode: z.enum(["new", "resume", "unbound"]),
    sessionId: PublicIdSchema.optional(),
    title: z.string().min(1).max(PUBLIC_CONVERSATION_TITLE_MAX_CHARS).optional(),
    source: z.string().min(1).max(64).optional(),
    preview: z.string().max(PUBLIC_CONVERSATION_PREVIEW_MAX_CHARS).optional(),
    lastActiveAt: PublicTimestampSchema.optional(),
  })
  .strict()
  .superRefine((conversation, context) => {
    if (conversation.mode !== "unbound" && conversation.sessionId === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A bound conversation requires sessionId." });
    }
    if (conversation.mode === "unbound" && conversation.sessionId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "An unbound conversation cannot include sessionId." });
    }
  });
export type PublicConversation = z.infer<typeof PublicConversationSchema>;

const TaskEventBase = {
  sequence: PositiveTaskSequenceSchema,
  taskId: TaskIdSchema,
  occurredAt: PublicTimestampSchema,
};

const SessionReadyMessageSchema = z
  .object({
    type: z.literal("session.ready"),
    protocolVersion: z.union([z.literal(3), z.literal(4)]),
    requestId: RequestIdSchema.optional(),
    sessionId: PublicIdSchema,
    model: z.string().min(1).max(PUBLIC_MODEL_MAX_CHARS),
    hermes: z
      .object({
        model: z.string().min(1).max(PUBLIC_MODEL_MAX_CHARS).optional(),
        capabilities: BoundedJsonObjectSchema.optional(),
      })
      .strict(),
    realtime: RealtimeClientCapabilitiesSchema,
    tasks: TaskCapabilitiesSchema,
    conversation: PublicConversationSchema.optional(),
  })
  .strict();

const SessionErrorMessageSchema = z
  .object({
    type: z.literal("session.error"),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(PUBLIC_TASK_ERROR_MAX_CHARS),
    requestId: RequestIdSchema.optional(),
    recoverable: z.boolean().default(false),
  })
  .strict();

const AudioOutputMessageSchema = z
  .object({
    type: z.literal("audio.output"),
    data: z.string().min(1).max(PUBLIC_AUDIO_BASE64_MAX_CHARS),
    mimeType: z.string().min(1).max(PUBLIC_MIME_TYPE_MAX_CHARS),
    itemId: PublicIdSchema.optional(),
    contentIndex: z.number().int().nonnegative().max(100).optional(),
  })
  .strict();

const TranscriptDeltaMessageSchema = z
  .object({
    type: z.literal("transcript.delta"),
    speaker: z.enum(["user", "assistant", "system"]),
    text: z.string().min(1).max(PUBLIC_TRANSCRIPT_MAX_CHARS),
    final: z.boolean().optional(),
  })
  .strict();

const InputSpeechStartedMessageSchema = z
  .object({
    type: z.literal("input.speech_started"),
    provider: z.literal("openai"),
    itemId: PublicIdSchema.optional(),
    audioStartMs: z.number().finite().nonnegative().max(60 * 60 * 1_000).optional(),
  })
  .strict();

const ResponseStartedMessageSchema = z
  .object({ type: z.literal("response.started"), responseId: PublicIdSchema.optional() })
  .strict();
const ResponseCompletedMessageSchema = z
  .object({ type: z.literal("response.completed"), responseId: PublicIdSchema.optional() })
  .strict();
const ResponseCancelledMessageSchema = z
  .object({ type: z.literal("response.cancelled"), responseId: PublicIdSchema.optional() })
  .strict();
const ResponseFailedMessageSchema = z
  .object({
    type: z.literal("response.failed"),
    responseId: PublicIdSchema.optional(),
    error: z.string().min(1).max(PUBLIC_TASK_ERROR_MAX_CHARS),
  })
  .strict();

const TaskSnapshotMessageSchema = z
  .object({
    type: z.literal("task.snapshot"),
    reason: z.enum(["initial", "reconnect", "list", "get"]),
    requestId: RequestIdSchema.optional(),
    tasks: z.array(PublicTaskSnapshotSchema).max(TASK_LIST_MAX_LIMIT),
    truncated: z.boolean().default(false),
  })
  .strict()
  .superRefine((message, context) => {
    if ((message.reason === "list" || message.reason === "get") && message.requestId === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${message.reason} snapshots require requestId.` });
    }
    if (message.reason === "get" && message.tasks.length > 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A get snapshot can contain at most one task." });
    }
  });

const TaskAcceptedMessageSchema = z
  .object({
    type: z.literal("task.accepted"),
    ...TaskEventBase,
    requestId: RequestIdSchema.optional(),
    state: z.enum(["accepted", "queued"]),
    title: z.string().min(1).max(PUBLIC_TASK_TITLE_MAX_CHARS).optional(),
    kind: z.enum(["background", "follow_up"]).optional(),
    parentTaskId: TaskIdSchema.optional(),
    rootTaskId: TaskIdSchema.optional(),
  })
  .strict();

const TaskStartedMessageSchema = z
  .object({
    type: z.literal("task.started"),
    ...TaskEventBase,
    title: z.string().min(1).max(PUBLIC_TASK_TITLE_MAX_CHARS).optional(),
  })
  .strict();

const TaskProgressMessageSchema = z
  .object({ type: z.literal("task.progress"), ...TaskEventBase, progress: PublicTaskProgressSchema })
  .strict();

const TaskStoppingMessageSchema = z
  .object({
    type: z.literal("task.stopping"),
    ...TaskEventBase,
    requestId: RequestIdSchema.optional(),
    reason: z.string().max(1_000).optional(),
  })
  .strict();

const TaskCompletedMessageSchema = z
  .object({
    type: z.literal("task.completed"),
    ...TaskEventBase,
    requestId: RequestIdSchema.optional(),
    result: PublicTaskResultSchema,
  })
  .strict();

const TaskFailedMessageSchema = z
  .object({
    type: z.literal("task.failed"),
    ...TaskEventBase,
    requestId: RequestIdSchema.optional(),
    error: PublicTaskErrorSchema,
  })
  .strict();

const TaskCancelledMessageSchema = z
  .object({
    type: z.literal("task.cancelled"),
    ...TaskEventBase,
    requestId: RequestIdSchema.optional(),
    reason: z.string().max(1_000).optional(),
  })
  .strict();

const TaskUnknownMessageSchema = z
  .object({
    type: z.literal("task.unknown"),
    ...TaskEventBase,
    requestId: RequestIdSchema.optional(),
    error: PublicTaskErrorSchema,
  })
  .strict();

const TaskNotificationMessageSchema = z
  .object({
    type: z.literal("task.notification"),
    ...TaskEventBase,
    requestId: RequestIdSchema.optional(),
    notification: TaskNotificationSchema,
  })
  .strict();

const LogMessageSchema = z
  .object({
    type: z.literal("log"),
    level: z.enum(["debug", "info", "warn", "error"]),
    message: z.string().min(1).max(PUBLIC_LOG_MAX_CHARS),
    data: BoundedJsonObjectSchema.optional(),
  })
  .strict();

export const ServerMessageSchema = z.union([
  SessionReadyMessageSchema,
  SessionErrorMessageSchema,
  AudioOutputMessageSchema,
  TranscriptDeltaMessageSchema,
  InputSpeechStartedMessageSchema,
  ResponseStartedMessageSchema,
  ResponseCompletedMessageSchema,
  ResponseCancelledMessageSchema,
  ResponseFailedMessageSchema,
  TaskSnapshotMessageSchema,
  TaskAcceptedMessageSchema,
  TaskStartedMessageSchema,
  TaskProgressMessageSchema,
  TaskStoppingMessageSchema,
  TaskCompletedMessageSchema,
  TaskFailedMessageSchema,
  TaskCancelledMessageSchema,
  TaskUnknownMessageSchema,
  TaskNotificationMessageSchema,
  LogMessageSchema,
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type SessionReadyMessage = Extract<ServerMessage, { type: "session.ready" }>;
export type TaskSnapshotMessage = Extract<ServerMessage, { type: "task.snapshot" }>;
export type TaskLifecycleMessage = Extract<ServerMessage, { type: `task.${string}` }>;

// HermesRunEvent remains an internal upstream-adapter type. Raw run events are
// deliberately not members of the public protocol-v4 ServerMessage union.
export interface HermesRunEvent {
  event?: string;
  run_id?: string;
  timestamp?: number;
  delta?: string;
  output?: string;
  error?: string | boolean;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseServerMessage(value: unknown): ServerMessage {
  return ServerMessageSchema.parse(value);
}

export function serverMessage(value: ServerMessage): string {
  return JSON.stringify(ServerMessageSchema.parse(value));
}
