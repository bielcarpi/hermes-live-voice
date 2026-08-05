import type { LiveToolName } from "./ports/realtime-model.port.js";

const TASK_ID_SCHEMA = {
  type: "string",
  pattern: "^task_[a-f0-9]{32}$",
  description: "The stable Hermes Live task id returned by start_background_task or list_background_tasks.",
} as const;

const HERMES_LIVE_TOOL_DEFINITIONS = [
  {
    name: "continue_hermes_conversation",
    description:
      "Send one conversational turn to the Hermes session selected by the user. Use it for answers, memory, and follow-ups that must remain in that persisted chat; use a background task for long independent work.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          type: "string",
          description: "The complete user request to append to the selected Hermes conversation.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "start_background_task",
    description:
      "Delegate meaningful work to Hermes Agent as a durable background task. Returns quickly; the user may keep talking or disconnect while the task continues.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: { type: "string", description: "The complete, concise task Hermes should perform." },
        title: { type: "string", description: "A short user-facing title for the task inbox." },
        recent_voice_context: {
          type: "string",
          description: "Only the minimum recent voice context required to resolve references in the task.",
        },
        execution_mode: {
          type: "string",
          enum: ["exclusive", "parallel_read_only"],
          description:
            "Use exclusive unless the task is provably read-only. Read-only tasks overlap only when their resource_keys are disjoint; mutating tasks are serialized.",
        },
        resource_keys: {
          type: "array",
          maxItems: 8,
          items: { type: "string" },
          description:
            "Stable resources read or touched by the task, such as an absolute repository path or deployment target. Tasks sharing a key never overlap.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "list_background_tasks",
    description: "List this user's active and recent Hermes background tasks from the durable task inbox.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        include_completed: {
          type: "boolean",
          description: "Include recent terminal tasks. Defaults to true.",
        },
        summary_only: {
          type: "boolean",
          description: "Return a short safe spoken count instead of task details when the user asks only what is running.",
        },
      },
    },
  },
  {
    name: "get_background_task",
    description: "Read the exact status or retained result of one Hermes background task.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: TASK_ID_SCHEMA,
        include_output: {
          type: "boolean",
          description: "Include the bounded final output when it is available and the user asked for details.",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "follow_up_background_task",
    description:
      "Start durable follow-up work from a finished task and its retained result. Use the exact task_id returned by the gateway. The follow-up is a new independently stoppable task in the same lineage.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: TASK_ID_SCHEMA,
        message: { type: "string", description: "The user's complete follow-up request." },
        title: { type: "string", description: "Optional short title for the follow-up task." },
      },
      required: ["task_id", "message"],
    },
  },
  {
    name: "stop_background_task",
    description: "Request cooperative cancellation of one exact Hermes background task.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: TASK_ID_SCHEMA,
        reason: { type: "string", description: "A short reason for the cancellation request." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "pause_voice_input",
    description:
      "Pause microphone listening only when the user explicitly asks to pause, mute, or stop listening. This keeps Live Voice connected and leaves every background task running; the user resumes from the client control.",
    parametersJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
] as const satisfies ReadonlyArray<{
  name: LiveToolName;
  description: string;
  parametersJsonSchema: Readonly<Record<string, unknown>>;
}>;

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

const COMPACT_TOOL_DESCRIPTIONS: Record<LiveToolName, string> = {
  continue_hermes_conversation: "Continue the selected saved Hermes chat for one short turn.",
  start_background_task: "Start durable Hermes work while the user keeps talking or disconnects.",
  list_background_tasks: "List active and recent tasks with their exact ids.",
  get_background_task: "Get one task's exact status or retained result.",
  follow_up_background_task: "Start new durable work from one finished task.",
  stop_background_task: "Request cancellation of one exact task.",
  pause_voice_input: "Pause microphone input without stopping tasks or disconnecting.",
};

export function selectHermesLiveToolDeclarations(names?: readonly LiveToolName[]) {
  if (names === undefined) return HERMES_LIVE_TOOL_DECLARATIONS;
  const allowed = new Set(names);
  return HERMES_LIVE_TOOL_DECLARATIONS.filter((tool) => allowed.has(tool.name));
}

export function selectOpenAIHermesLiveTools(names?: readonly LiveToolName[]) {
  if (names === undefined) return OPENAI_HERMES_LIVE_TOOLS;
  const allowed = new Set(names);
  return OPENAI_HERMES_LIVE_TOOLS.filter((tool) => allowed.has(tool.name));
}

/** Keep local-model prefill small without changing names, validation, or capabilities. */
export function selectCompactOpenAIHermesLiveTools(names?: readonly LiveToolName[]) {
  return selectOpenAIHermesLiveTools(names).map((tool) => ({
    ...tool,
    description: COMPACT_TOOL_DESCRIPTIONS[tool.name],
    parameters: withoutJsonSchemaDescriptions(tool.parameters),
  }));
}

function withoutJsonSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutJsonSchemaDescriptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "description")
      .map(([key, child]) => [key, withoutJsonSchemaDescriptions(child)]),
  );
}
