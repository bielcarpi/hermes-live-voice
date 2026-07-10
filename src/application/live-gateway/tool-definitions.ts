const HERMES_LIVE_TOOL_DEFINITIONS = [
  {
    name: "start_agent_run",
    description:
      "Start an agent run when the user asks for real work, memory, tools, files, terminal, research, or longer reasoning.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The concise task or question the agent should handle." },
        recent_voice_context: { type: "string", description: "Short recent voice context that helps the agent understand references." },
      },
      required: ["message"],
    },
  },
  {
    name: "get_agent_run_status",
    description: "Check the current status of an agent run.",
    parametersJsonSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
  },
  {
    name: "stop_agent_run",
    description: "Stop an active agent run when the user interrupts or asks to cancel.",
    parametersJsonSchema: { type: "object", properties: { run_id: { type: "string" }, reason: { type: "string" } } },
  },
  {
    name: "submit_agent_approval",
    description: "Submit a human approval decision for an agent run waiting on approval.",
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
  {
    name: "generate_agent_random_number",
    description:
      "Generate a random integer without starting an agent run. Use this only for latency/connectivity testing, not for real work.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        min: { type: "number", description: "Inclusive lower bound. Defaults to 0." },
        max: { type: "number", description: "Inclusive upper bound. Defaults to 100." },
      },
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
