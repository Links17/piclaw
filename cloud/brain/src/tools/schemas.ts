/** OpenAI-compatible function tool definitions for the brain tool loop. */
export const TOOL_DEFINITIONS = [
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
];

export const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));
