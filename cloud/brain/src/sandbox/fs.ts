import type { Sandbox } from "./client.ts";

export async function writeFile(sandbox: Sandbox, path: string, content: string): Promise<void> {
  try {
    await sandbox.files.write(path, content);
    return;
  } catch {
    // CubeSandbox envd write API gap — shell fallback.
  }
  const dir = path.replace(/\/[^/]+$/, "");
  if (dir && dir !== path) {
    await sandbox.commands.run(`mkdir -p ${shellQuote(dir)}`);
  }
  const result = await sandbox.commands.run(
    `printf '%s' ${shellQuote(content)} > ${shellQuote(path)}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`writeFile(${path}) failed: ${result.stderr}`);
  }
}

export async function readFile(sandbox: Sandbox, path: string): Promise<string> {
  return String(await sandbox.files.read(path));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
