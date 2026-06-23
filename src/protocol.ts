import { z } from "zod";

export const ApprovalChoiceSchema = z.enum(["once", "session", "always", "deny"]);
export type ApprovalChoice = z.infer<typeof ApprovalChoiceSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.start"),
    id: z.string().optional(),
    profileId: z.string().optional(),
    userLabel: z.string().optional(),
  }),
  z.object({
    type: z.literal("audio.input"),
    id: z.string().optional(),
    data: z.string().min(1),
    mimeType: z.string().default("audio/pcm;rate=24000"),
  }),
  z.object({ type: z.literal("audio.end"), id: z.string().optional() }),
  z.object({ type: z.literal("text.input"), id: z.string().optional(), text: z.string().min(1) }),
  z.object({ type: z.literal("response.cancel"), id: z.string().optional(), reason: z.string().optional() }),
  z.object({
    type: z.literal("approval.respond"),
    id: z.string().optional(),
    runId: z.string().min(1),
    choice: ApprovalChoiceSchema,
    resolveAll: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("run.stop"),
    id: z.string().optional(),
    runId: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal("session.close"), id: z.string().optional() }),
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
  | { type: "audio.output"; data: string; mimeType: string }
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
