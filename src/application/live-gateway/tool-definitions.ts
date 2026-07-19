const TASK_ID_SCHEMA = {
  type: "string",
  pattern: "^task_[a-f0-9]{32}$",
  description: "The stable Hermes Live task id returned by start_background_task.",
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
