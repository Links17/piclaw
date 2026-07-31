import { Type, type AgentTool } from "@piclaw/agent-kernel";
import { dispatchTool } from "../tools/dispatcher.ts";
import type { ToolDefinition } from "../tools/schemas.ts";

const bashSchema = Type.Object({
  command: Type.String(),
});

const readSchema = Type.Object({
  path: Type.String(),
});

const writeSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

const editSchema = Type.Object({
  path: Type.String(),
  old_string: Type.String(),
  new_string: Type.String(),
});

const questionSchema = Type.Object({
  question: Type.String(),
  options: Type.Array(
    Type.Object({
      label: Type.String(),
      description: Type.Optional(Type.String()),
    }),
  ),
});

const skillSchema = Type.Object({
  name: Type.String(),
});

const todoSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("add"),
    Type.Literal("toggle"),
    Type.Literal("clear"),
  ]),
  text: Type.Optional(Type.String()),
  id: Type.Optional(Type.Number()),
});

const agentSchema = Type.Object({
  prompt: Type.String(),
  description: Type.String(),
  subagent_type: Type.Union([
    Type.Literal("general-purpose"),
    Type.Literal("explore"),
    Type.Literal("plan"),
  ]),
  model: Type.Optional(Type.String()),
  max_turns: Type.Optional(Type.Number()),
  run_in_background: Type.Optional(Type.Boolean()),
  resume: Type.Optional(Type.String()),
  schedule: Type.Optional(Type.String()),
});

const codingAgentSchema = Type.Object({
  task: Type.String(),
  constraints: Type.Optional(Type.String()),
  timeout_ms: Type.Optional(Type.Number()),
});

const getSubagentResultSchema = Type.Object({
  agent_id: Type.String(),
  wait: Type.Optional(Type.Boolean()),
  verbose: Type.Optional(Type.Boolean()),
});

const steerSubagentSchema = Type.Object({
  agent_id: Type.String(),
  message: Type.String(),
});

const KNOWN_SCHEMAS: Record<string, ReturnType<typeof Type.Object>> = {
  bash: bashSchema,
  read: readSchema,
  write: writeSchema,
  edit: editSchema,
  question: questionSchema,
  skill: skillSchema,
  todo: todoSchema,
  Agent: agentSchema,
  coding_agent: codingAgentSchema,
  get_subagent_result: getSubagentResultSchema,
  steer_subagent: steerSubagentSchema,
};

function schemaForTool(definition: ToolDefinition) {
  const known = KNOWN_SCHEMAS[definition.function.name];
  if (known) return known;
  return Type.Unsafe(definition.function.parameters);
}

export function buildAgentTools(
  sessionId: string,
  sessionMode: "plan" | "execute",
  definitions: ToolDefinition[],
): AgentTool[] {
  return definitions.map((definition) => {
    const name = definition.function.name;
    return {
      name,
      label: name,
      description: definition.function.description,
      parameters: schemaForTool(definition),
      ...(name === "question" ? { executionMode: "sequential" as const } : {}),
      execute: async (toolCallId, params, signal) => {
        void toolCallId;
        void signal;
        const result = await dispatchTool(
          sessionId,
          name,
          params as Record<string, unknown>,
          sessionMode,
          definitions,
        );
        return {
          content: [{ type: "text" as const, text: result.output }],
          details: result.output,
          isError: result.isError,
        };
      },
    };
  });
}
