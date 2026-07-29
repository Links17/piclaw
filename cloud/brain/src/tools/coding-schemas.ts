/** Tool definitions for the coding subagent inner loop (sandbox-only tools). */
export const CODING_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "bash",
      description: "Run a shell command in /workspace.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read",
      description: "Read a text file from /workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write",
      description: "Write a text file under /workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit",
      description: "Replace one unique occurrence in a workspace file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
];

export const CODING_TOOL_NAMES = new Set(CODING_TOOL_DEFINITIONS.map((t) => t.function.name));
