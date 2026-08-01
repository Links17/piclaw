/** Core slash commands exposed to the compose-box autocomplete. */
export interface CommandEntry {
  name: string;
  description: string;
  source: "core" | "extension" | "pi-extension" | "skill" | "template";
}

export const CORE_COMMAND_DEFINITIONS: Array<{ name: string; description: string; aliases?: string[] }> = [
  { name: "/model", description: "Select model or list available models" },
  { name: "/thinking", description: "Show or set thinking/effort level", aliases: ["/effort"] },
  { name: "/context", description: "Show context window usage", aliases: ["/ctx"] },
  { name: "/abort", description: "Abort the current response" },
  { name: "/plan", description: "Enter plan mode" },
  { name: "/execute", description: "Execute the approved plan" },
  { name: "/settings", description: "Open the settings dialog" },
  { name: "/commands", description: "List available commands" },
];

export function buildCoreCommandList(): CommandEntry[] {
  const entries: CommandEntry[] = [];
  const seen = new Set<string>();
  for (const cmd of CORE_COMMAND_DEFINITIONS) {
    const add = (name: string) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ name, description: cmd.description, source: "core" });
    };
    add(cmd.name);
    for (const alias of cmd.aliases ?? []) add(alias);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
