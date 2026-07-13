import { z } from "zod";

const REQUEST_ID_MAX_CHARS = 128;
const CLIENT_METADATA_MAX_CHARS = 256;
const CLIENT_REASON_MAX_CHARS = 1_000;
const CLIENT_MIME_TYPE_MAX_CHARS = 128;
const MAX_TRUNCATION_AUDIO_MS = 60 * 60 * 1_000;

const RequestIdSchema = z.string().max(REQUEST_ID_MAX_CHARS).optional();
const RequiredRequestIdSchema = z.string().min(1).max(REQUEST_ID_MAX_CHARS);
const ClientMetadataStringSchema = z.string().max(CLIENT_METADATA_MAX_CHARS);
const ClientRequiredMetadataStringSchema = z.string().min(1).max(CLIENT_METADATA_MAX_CHARS);
const ClientReasonSchema = z.string().max(CLIENT_REASON_MAX_CHARS);

export const ApprovalChoiceSchema = z.enum(["once", "session", "always", "deny"]);
export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>;

export const RealtimeResponseTruncationSchema = z.object({
  itemId: ClientRequiredMetadataStringSchema,
  contentIndex: z.number().int().nonnegative().max(100).default(0),
  audioEndMs: z.number().finite().nonnegative().max(MAX_TRUNCATION_AUDIO_MS),
});
export type RealtimeResponseTruncation = z.infer<typeof RealtimeResponseTruncationSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.start"),
    id: RequestIdSchema,
    protocolVersion: z.number().int().positive().max(1_000).optional(),
    profileId: ClientMetadataStringSchema.optional(),
    userLabel: ClientMetadataStringSchema.optional(),
  }),
  z.object({
    type: z.literal("audio.input"),
    id: RequestIdSchema,
    data: z.string().min(1),
    mimeType: z.string().max(CLIENT_MIME_TYPE_MAX_CHARS).default("audio/pcm;rate=24000"),
  }),
  z.object({ type: z.literal("audio.end"), id: RequestIdSchema }),
  z.object({ type: z.literal("text.input"), id: RequestIdSchema, text: z.string().min(1) }),
  z.object({
    type: z.literal("response.cancel"),
    id: RequestIdSchema,
    reason: ClientReasonSchema.optional(),
    truncate: RealtimeResponseTruncationSchema.optional(),
  }),
  z.object({
    type: z.literal("approval.respond"),
    id: RequiredRequestIdSchema,
    runId: ClientRequiredMetadataStringSchema,
    approvalId: ClientRequiredMetadataStringSchema,
    choice: ApprovalChoiceSchema,
    resolveAll: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("run.stop"),
    id: RequestIdSchema,
    runId: ClientRequiredMetadataStringSchema.optional(),
    reason: ClientReasonSchema.optional(),
  }),
  z.object({ type: z.literal("session.close"), id: RequestIdSchema }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export function parseClientMessage(value: unknown): ClientMessage {
  return ClientMessageSchema.parse(value);
}
