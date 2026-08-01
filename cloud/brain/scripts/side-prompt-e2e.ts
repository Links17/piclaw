/**
 * Real Brain acceptance for the isolated side-prompt SSE API.
 *
 * Requires a running Brain with a real configured model. This script never
 * substitutes a mock model for an API/SSE claim.
 */
import { RealAcceptance } from "../src/e2e/real-acceptance.ts";
import { createApiKey } from "@piclaw-cloud/store";
import { sql } from "@piclaw-cloud/store/db";
import { spawnBrain } from "../src/e2e/spawn-brain.ts";

const BASE_CONFIG = new URL("../../brain.config.llm-e2e.json", import.meta.url).pathname;
const API_KEY = process.env.CLOUD_OPENAI_API_KEY
  || await Bun.file(new URL("../../brain.config.json", import.meta.url).pathname)
    .json()
    .then((cfg: { openai?: { apiKey?: string } }) => cfg.openai?.apiKey ?? "");
if (!API_KEY || API_KEY === "sk-your-key-here") {
  throw new Error("Missing CLOUD_OPENAI_API_KEY / brain.config.json openai.apiKey");
}
const PORT = Number(process.env.CLOUD_SIDE_PROMPT_PORT || 17931);
const run = new RealAcceptance();
const CHAT = run.session("side-prompt");
const userId = `${run.id}-side-user`;
const bearer = `${run.id}-side-key`;
run.addResource("users", userId);
run.addResource("usageUsers", userId);
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${bearer}`,
};

async function readSse(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  return [...text.matchAll(/event: ([^\n]+)\ndata: ([^\n]*)\n\n/g)].map((match) => ({
    event: match[1]!,
    data: JSON.parse(match[2]!),
  }));
}

console.log("Side prompt real API/SSE acceptance");
console.log(`  chat:  ${CHAT}`);

try {
  await run.preflight(null, { requireLlm: true, skipBrain: true });
  await sql`
    INSERT INTO users (id, email, display_name)
    VALUES (${userId}, ${`${userId}@example.test`}, 'Side Prompt E2E')`;
  await createApiKey(userId, bearer, "side-prompt-e2e");
  const brain = await spawnBrain({
    port: PORT,
    replicaId: `${run.id}-side`,
    baseConfigPath: BASE_CONFIG,
    apiKey: API_KEY,
    overrides: {
      limits: { maxDailyTokensPerUser: 100_000 },
      sandbox: { enabled: false },
      auth: { required: true },
    },
  });
  run.trackProcess("side-brain", brain.stop);
  console.log(`  brain: ${brain.baseUrl}`);
  const create = await fetch(`${brain.baseUrl}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: CHAT, title: "side prompt e2e" }),
  });
  if (!create.ok) throw new Error(`create session failed: ${create.status} ${await create.text()}`);

  const unauthenticated = await fetch(`${brain.baseUrl}/agent/side-prompt/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-side-prompt-key" },
    body: JSON.stringify({ chat_jid: CHAT, prompt: "This must not reach the model." }),
  });
  run.check(unauthenticated.status === 401, "rejects invalid credentials");

  const stream = await fetch(`${brain.baseUrl}/agent/side-prompt/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ chat_jid: CHAT, prompt: "Reply with exactly SIDE_PROMPT_E2E_OK." }),
  });
  const events = await readSse(stream);
  const names = events.map((event) => event.event);
  run.check(stream.status === 200, "accepts authorized request");
  run.check(stream.headers.get("content-type")?.includes("text/event-stream") === true, "returns an SSE response");
  run.check(names[0] === "side_prompt_start", "emits side_prompt_start");
  run.check(
    names.includes("side_prompt_done"),
    "terminates with side_prompt_done",
    JSON.stringify(events),
  );
  run.check(names.includes("side_prompt_text_delta"), "emits text delta before completion");

  const transcript = await (await fetch(
    `${brain.baseUrl}/sessions/${encodeURIComponent(CHAT)}/messages`,
    { headers },
  )).json() as {
    messages?: Array<{ content?: string }>;
  };
  run.check((transcript.messages?.length ?? 0) === 0, "does not write a primary transcript message");
} finally {
  await run.cleanup();
  const report = await run.writeReport();
  console.log(`report: ${report}`);
}
