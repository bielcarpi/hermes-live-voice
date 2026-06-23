import { z } from "zod";

const REQUEST_ID_MAX_CHARS = 128;
const CLIENT_METADATA_MAX_CHARS = 256;
const CLIENT_REASON_MAX_CHARS = 1_000;
const CLIENT_MIME_TYPE_MAX_CHARS = 128;
const MAX_TRUNCATION_AUDIO_MS = 60 * 60 * 1_000;

const RequestIdSchema = z.string().max(REQUEST_ID_MAX_CHARS).optional();
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
    id: RequestIdSchema,
    runId: ClientRequiredMetadataStringSchema,
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

export type ServerMessage =
  | {
      type: "session.ready";
      sessionId: string;
      model: string;
      hermes: { model?: string; capabilities?: Record<string, unknown> };
    }
  | { type: "session.error"; code: string; message: string; requestId?: string; recoverable?: boolean }
  | { type: "audio.output"; data: string; mimeType: string; itemId?: string; contentIndex?: number }
  | { type: "transcript.delta"; speaker: "user" | "assistant" | "system"; text: string; final?: boolean }
  | { type: "realtime.message"; message: unknown }
  | { type: "run.started"; runId: string; sessionId: string }
  | { type: "run.event"; runId: string; event: HermesRunEvent }
  | { type: "approval.request"; runId: string; event: HermesRunEvent }
  | { type: "approval.responded"; runId: string; choice: ApprovalChoice; resolved?: number }
  | { type: "run.completed"; runId: string; output: string; usage?: Record<string, unknown> }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.stopped"; runId: string; status: string }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; data?: unknown };

export interface HermesRunEvent {
  event?: string;
  run_id?: string;
  timestamp?: number;
  delta?: string;
  output?: string;
  error?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LiveToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveModelAudio {
  data: string;
  mimeType: string;
  itemId?: string;
  contentIndex?: number;
}

export type LiveModelEvent =
  | { type: "audio"; audio: LiveModelAudio }
  | { type: "text"; text: string }
  | { type: "tool_call"; call: LiveToolCall }
  | { type: "raw"; message: unknown };

export function parseClientMessage(value: unknown): ClientMessage {
  return ClientMessageSchema.parse(value);
}

export function serverMessage(value: ServerMessage): string {
  return JSON.stringify(value);
}

const HERMES_LIVE_TOOL_DEFINITIONS = [
  {
    name: "start_hermes_run",
    description:
      "Start a Hermes Agent run when the user asks for real work, memory, tools, files, terminal, research, or longer reasoning.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The concise task or question Hermes should handle." },
        recent_voice_context: { type: "string", description: "Short recent voice context that helps Hermes understand references." },
      },
      required: ["message"],
    },
  },
  {
    name: "get_hermes_run_status",
    description: "Check the current status of a Hermes run.",
    parametersJsonSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
  },
  {
    name: "stop_hermes_run",
    description: "Stop an active Hermes run when the user interrupts or asks to cancel.",
    parametersJsonSchema: { type: "object", properties: { run_id: { type: "string" }, reason: { type: "string" } } },
  },
  {
    name: "submit_hermes_approval",
    description: "Submit a human approval decision for a Hermes run waiting on approval.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        choice: { type: "string", enum: ["once", "session", "always", "deny"] },
        resolve_all: { type: "boolean" },
      },
      required: ["run_id", "choice"],
    },
  },
] as const;

export const HERMES_LIVE_TOOL_DECLARATIONS = HERMES_LIVE_TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  parametersJsonSchema: tool.parametersJsonSchema,
}));

export const OPENAI_HERMES_LIVE_TOOLS = HERMES_LIVE_TOOL_DEFINITIONS.map((tool) => ({
  type: "function" as const,
  name: tool.name,
  description: tool.description,
  parameters: tool.parametersJsonSchema,
}));
