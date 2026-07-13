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
