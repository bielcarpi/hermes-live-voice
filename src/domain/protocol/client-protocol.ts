import { z } from "zod";

const REQUEST_ID_MAX_CHARS = 128;
const CLIENT_METADATA_MAX_CHARS = 256;
const CLIENT_REASON_MAX_CHARS = 1_000;
const CLIENT_MIME_TYPE_MAX_CHARS = 128;
const CLIENT_TEXT_HARD_MAX_CHARS = 1_000_000;
const CLIENT_AUDIO_BASE64_HARD_MAX_CHARS = 8_000_000;
const MAX_TRUNCATION_AUDIO_MS = 60 * 60 * 1_000;

export const TASK_ID_MAX_CHARS = 256;
export const NOTIFICATION_ID_MAX_CHARS = 256;
export const TASK_LIST_DEFAULT_LIMIT = 50;
export const TASK_LIST_MAX_LIMIT = 100;
export const MAX_TASK_SEQUENCE = Number.MAX_SAFE_INTEGER;

const OpaqueIdSchema = (maxChars: number) =>
  z
    .string()
    .min(1)
    .max(maxChars)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected an opaque identifier without whitespace or control characters.");

export const RequestIdSchema = OpaqueIdSchema(REQUEST_ID_MAX_CHARS);
export const TaskIdSchema = OpaqueIdSchema(TASK_ID_MAX_CHARS);
export const NotificationIdSchema = OpaqueIdSchema(NOTIFICATION_ID_MAX_CHARS);
// Sequence is a monotonic revision within one stable taskId. It is not an
// owner-global replay cursor; reconnects receive a bounded task snapshot and
// deduplicate updates by taskId + sequence.
export const TaskSequenceSchema = z.number().int().nonnegative().max(MAX_TASK_SEQUENCE);

const OptionalRequestIdSchema = RequestIdSchema.optional();
const ClientMetadataStringSchema = z.string().max(CLIENT_METADATA_MAX_CHARS);
const ClientReasonSchema = z.string().max(CLIENT_REASON_MAX_CHARS);

export const ApprovalChoiceSchema = z.enum(["once", "session", "always", "deny"]);
export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>;

export const RealtimeResponseTruncationSchema = z
  .object({
    itemId: OpaqueIdSchema(CLIENT_METADATA_MAX_CHARS),
    contentIndex: z.number().int().nonnegative().max(100).default(0),
    audioEndMs: z.number().finite().nonnegative().max(MAX_TRUNCATION_AUDIO_MS),
  })
  .strict();
export type RealtimeResponseTruncation = z.infer<typeof RealtimeResponseTruncationSchema>;

const SessionStartMessageSchema = z
  .object({
    type: z.literal("session.start"),
    id: OptionalRequestIdSchema,
    // The parser deliberately accepts an integer here so the session boundary can
    // return the actionable unsupported_protocol_version error for v2 clients.
    protocolVersion: z.number().int().positive().max(1_000),
    profileId: ClientMetadataStringSchema.optional(),
    userLabel: ClientMetadataStringSchema.optional(),
  })
  .strict();

const AudioInputMessageSchema = z
  .object({
    type: z.literal("audio.input"),
    id: OptionalRequestIdSchema,
    data: z.string().min(1).max(CLIENT_AUDIO_BASE64_HARD_MAX_CHARS),
    mimeType: z.string().min(1).max(CLIENT_MIME_TYPE_MAX_CHARS).default("audio/pcm;rate=24000"),
  })
  .strict();

const AudioEndMessageSchema = z.object({ type: z.literal("audio.end"), id: OptionalRequestIdSchema }).strict();

const TextInputMessageSchema = z
  .object({
    type: z.literal("text.input"),
    id: OptionalRequestIdSchema,
    text: z.string().min(1).max(CLIENT_TEXT_HARD_MAX_CHARS),
  })
  .strict();

const ResponseCancelMessageSchema = z
  .object({
    type: z.literal("response.cancel"),
    id: OptionalRequestIdSchema,
    reason: ClientReasonSchema.optional(),
    truncate: RealtimeResponseTruncationSchema.optional(),
  })
  .strict();

const TaskListMessageSchema = z
  .object({
    type: z.literal("task.list"),
    id: RequestIdSchema,
    limit: z.number().int().positive().max(TASK_LIST_MAX_LIMIT).default(TASK_LIST_DEFAULT_LIMIT),
  })
  .strict();

const TaskGetMessageSchema = z
  .object({
    type: z.literal("task.get"),
    id: RequestIdSchema,
    taskId: TaskIdSchema,
  })
  .strict();

const TaskStopMessageSchema = z
  .object({
    type: z.literal("task.stop"),
    id: RequestIdSchema,
    taskId: TaskIdSchema,
    reason: ClientReasonSchema.optional(),
  })
  .strict();

const TaskNotificationAckMessageSchema = z
  .object({
    type: z.literal("task.notification.ack"),
    id: RequestIdSchema,
    taskId: TaskIdSchema,
    notificationId: NotificationIdSchema,
  })
  .strict();

const SessionCloseMessageSchema = z
  .object({
    type: z.literal("session.close"),
    id: OptionalRequestIdSchema,
    // Protocol v3 detaches durable tasks. Cancellation is always an explicit
    // task.stop operation against one stable taskId.
    detach: z.literal(true).default(true),
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  SessionStartMessageSchema,
  AudioInputMessageSchema,
  AudioEndMessageSchema,
  TextInputMessageSchema,
  ResponseCancelMessageSchema,
  TaskListMessageSchema,
  TaskGetMessageSchema,
  TaskStopMessageSchema,
  TaskNotificationAckMessageSchema,
  SessionCloseMessageSchema,
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type SessionStartMessage = Extract<ClientMessage, { type: "session.start" }>;
export type TaskListMessage = Extract<ClientMessage, { type: "task.list" }>;
export type TaskGetMessage = Extract<ClientMessage, { type: "task.get" }>;
export type TaskStopMessage = Extract<ClientMessage, { type: "task.stop" }>;
export type TaskNotificationAckMessage = Extract<ClientMessage, { type: "task.notification.ack" }>;
export type SessionCloseMessage = Extract<ClientMessage, { type: "session.close" }>;

export function parseClientMessage(value: unknown): ClientMessage {
  return ClientMessageSchema.parse(value);
}
