/** OpenAI-compatible function tool definitions for the brain tool loop. */

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export const CORE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Run a shell command in the session sandbox. Working directory is /workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read",
      description: "Read a text file from /workspace in the sandbox.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative file path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write",
      description: "Write or overwrite a text file under /workspace in the sandbox.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative file path" },
          content: { type: "string", description: "Full file contents" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit",
      description:
        "Replace exactly one unique occurrence of old_string with new_string in a workspace file. Read the file first if unsure.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative file path" },
          old_string: { type: "string", description: "Exact text to replace (must appear once)" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "question",
      description:
        "Ask the user a clarifying question with options. Blocks until the user answers. Use when requirements are ambiguous.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask the user" },
          options: {
            type: "array",
            description: "Options for the user to choose from",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Display label for the option" },
                description: { type: "string", description: "Optional description shown below label" },
              },
              required: ["label"],
            },
          },
        },
        required: ["question", "options"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "skill",
      description:
        "Load the full instructions for a skill by name. Use after checking the skills catalog in the system prompt.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name from the catalog" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "todo",
      description: "Manage a session todo list for multi-step tasks.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "add", "toggle", "clear"],
            description: "Todo action",
          },
          text: { type: "string", description: "Todo text (for add)" },
          id: { type: "number", description: "Todo ID (for toggle)" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "Agent",
      description:
        "Launch a specialized subagent to perform a task. Supports background execution and resume.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task prompt for the subagent" },
          description: { type: "string", description: "Short human-readable description of the task" },
          subagent_type: {
            type: "string",
            enum: ["general-purpose", "explore", "plan"],
            description: "Subagent type",
          },
          model: { type: "string", description: "Optional model override" },
          max_turns: { type: "number", description: "Maximum tool rounds for the subagent" },
          run_in_background: { type: "boolean", description: "Return immediately while subagent runs in background" },
          resume: { type: "string", description: "Resume a previous subagent run by run id" },
          schedule: { type: "string", description: "Optional schedule e.g. cron, interval, +10m" },
        },
        required: ["prompt", "description", "subagent_type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "coding_agent",
      description: "Deprecated alias for Agent(subagent_type=general-purpose).",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Coding task description for the subagent" },
          constraints: { type: "string", description: "Optional constraints or acceptance criteria" },
          timeout_ms: { type: "number", description: "Optional timeout in milliseconds" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_subagent_result",
      description: "Fetch the result of a background subagent run, optionally waiting until completion.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Subagent run id" },
          wait: { type: "boolean", description: "Block until the subagent finishes" },
          verbose: { type: "boolean", description: "Include extra run metadata" },
        },
        required: ["agent_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "steer_subagent",
      description: "Send a steering message to a running subagent.",
      parameters: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "Subagent run id" },
          message: { type: "string", description: "Steering instruction for the subagent" },
        },
        required: ["agent_id", "message"],
      },
    },
  },
];

export const DISCOVERY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_tools",
      description: "List tools available to activate for this session, including MCP tools.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_tools",
      description: "Activate available tools by name for this session. Activated tools remain available in later turns.",
      parameters: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            description: "Tool names returned by list_tools",
          },
        },
        required: ["names"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reset_active_tools",
      description: "Reset this session's active tools to the small baseline set.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

const BASELINE_TOOL_NAMES = new Set([
  "read",
  "question",
  "todo",
  "skill",
  // Creating or modifying workspace code is the main Agent workflow. Keeping
  // this narrow delegating alias available prevents a staged-discovery loop
  // from consuming a real model's tool-round budget before it can delegate.
  "coding_agent",
  ...DISCOVERY_TOOL_DEFINITIONS.map((tool) => tool.function.name),
]);
const PLAN_MODE_ALLOWED = new Set(["read", "question", "todo", "skill", ...DISCOVERY_TOOL_DEFINITIONS.map((tool) => tool.function.name)]);

export type ToolCatalogEntry = Pick<ToolDefinition["function"], "name" | "description">;

export function getToolCatalog(extra: ToolDefinition[] = []): ToolCatalogEntry[] {
  return [...CORE_TOOL_DEFINITIONS, ...extra].map(({ function: tool }) => ({
    name: tool.name,
    description: tool.description,
  }));
}

export function getAllToolDefinitions(extra: ToolDefinition[] = []): ToolDefinition[] {
  return [...CORE_TOOL_DEFINITIONS, ...extra];
}

export function getToolDefinitionsForMode(
  mode: "plan" | "execute",
  extra: ToolDefinition[] = [],
  activeNames: ReadonlySet<string> = new Set(),
): ToolDefinition[] {
  const merged = [...CORE_TOOL_DEFINITIONS, ...extra];
  const allowed = mode === "plan" ? PLAN_MODE_ALLOWED : new Set([...BASELINE_TOOL_NAMES, ...activeNames]);
  const available = merged.filter((tool) => allowed.has(tool.function.name));
  return [...available, ...DISCOVERY_TOOL_DEFINITIONS];
}

export function toolNamesForMode(
  mode: "plan" | "execute",
  extra: ToolDefinition[] = [],
  activeNames: ReadonlySet<string> = new Set(),
): Set<string> {
  return new Set(getToolDefinitionsForMode(mode, extra, activeNames).map((tool) => tool.function.name));
}

export function activatableToolNames(extra: ToolDefinition[] = []): Set<string> {
  return new Set(getToolCatalog(extra).map((tool) => tool.name));
}

export const TOOL_DEFINITIONS = getToolDefinitionsForMode("execute");
export const TOOL_NAMES = toolNamesForMode("execute");
