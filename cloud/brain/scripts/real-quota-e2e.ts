/**
 * Real daily-token quota exhaustion acceptance.
 *
 * Uses an isolated user, a low maxDailyTokens Brain, one real LLM turn to
 * prove usage accounting, then advances the daily counter to the boundary and
 * verifies concurrent turn + side-prompt requests are rejected with HTTP 429
 * before any additional model call.
 */
import { createApiKey, getDailyTokenUsage, incrementDailyTokenUsage } from "@piclaw-cloud/store";
import { sql } from "@piclaw-cloud/store/db";
import { RealAcceptance } from "../src/e2e/real-acceptance.ts";
import { spawnBrain } from "../src/e2e/spawn-brain.ts";

const BASE_CONFIG = new URL("../../brain.config.llm-e2e.json", import.meta.url).pathname;
const API_KEY = process.env.CLOUD_OPENAI_API_KEY
  || await Bun.file(new URL("../../brain.config.json", import.meta.url).pathname)
    .json()
    .then((cfg: { openai?: { apiKey?: string } }) => cfg.openai?.apiKey ?? "");
const PORT = Number(process.env.CLOUD_QUOTA_PORT || 17921);
const MAX_DAILY_TOKENS = Number(process.env.CLOUD_QUOTA_E2E_LIMIT || 200);

const run = new RealAcceptance();
const userId = `${run.id}-quota-user`;
const sessionId = run.session("quota");
const bearer = `${run.id}-quota-key`;
run.addResource("users", userId);
run.addResource("usageUsers", userId);

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
  };
}

async function postMessage(base: string, content: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${base}/agent/default/message?chat_jid=${encodeURIComponent(sessionId)}&wait=1`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content }),
    },
  );
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function postSidePrompt(base: string, prompt: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/agent/side-prompt/stream`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ chat_jid: sessionId, prompt }),
  });
  if (response.status === 429) {
    return { status: 429, body: await response.json() as Record<string, unknown> };
  }
  // Exhaustion must reject before the SSE stream starts.
  const text = await response.text();
  return {
    status: response.status,
    body: { error: text.slice(0, 200), contentType: response.headers.get("content-type") ?? "" },
  };
}

async function messageCount(): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM messages WHERE session_id = ${sessionId}`;
  return Number(rows[0]?.n ?? 0);
}

if (!API_KEY || API_KEY === "sk-your-key-here") {
  console.error("Missing CLOUD_OPENAI_API_KEY / brain.config.json openai.apiKey");
  process.exit(2);
}

console.log(`Real token quota E2E (${sessionId})`);
console.log(`  port: ${PORT}`);
console.log(`  limit: ${MAX_DAILY_TOKENS}`);

try {
  await run.preflight(null, { requireLlm: true, skipBrain: true });

  await sql`
    INSERT INTO users (id, email, display_name)
    VALUES (${userId}, ${`${userId}@example.test`}, 'Real Quota E2E')`;
  await createApiKey(userId, bearer, "real-quota-e2e");

  const brain = await spawnBrain({
    port: PORT,
    replicaId: `${run.id}-quota`,
    baseConfigPath: BASE_CONFIG,
    apiKey: API_KEY,
    overrides: {
      limits: { maxDailyTokensPerUser: MAX_DAILY_TOKENS },
      sandbox: { enabled: false },
      auth: { required: false },
    },
  });
  run.trackProcess("quota-brain", brain.stop);

  const created = await fetch(`${brain.baseUrl}/sessions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ id: sessionId, title: "real quota acceptance" }),
  });
  run.check(created.ok, "creates isolated authenticated session");

  const beforeUsage = await getDailyTokenUsage(userId);
  run.check(beforeUsage === 0, "isolated user starts with zero daily usage");

  const first = await postMessage(brain.baseUrl, "Reply with exactly QUOTA_USAGE_OK.");
  run.check(first.status === 200 && first.body.outcome === "ran", "real LLM turn succeeds under quota");

  const afterFirst = await getDailyTokenUsage(userId);
  run.check(afterFirst > 0, "real LLM turn writes user_daily_usage", String(afterFirst));
  const messagesAfterFirst = await messageCount();
  run.check(messagesAfterFirst >= 2, "turn persisted user and assistant messages", String(messagesAfterFirst));

  if (afterFirst >= MAX_DAILY_TOKENS) {
    run.check(true, "real turn alone already reached the low daily limit", String(afterFirst));
  } else {
    const remaining = MAX_DAILY_TOKENS - afterFirst;
    await incrementDailyTokenUsage(userId, remaining, 0);
    const atLimit = await getDailyTokenUsage(userId);
    run.check(atLimit >= MAX_DAILY_TOKENS, "advanced daily usage exactly to the configured limit", String(atLimit));
  }

  const usageAtBoundary = await getDailyTokenUsage(userId);
  const messagesAtBoundary = await messageCount();

  const [turnA, turnB, sidePrompt] = await Promise.all([
    postMessage(brain.baseUrl, "This must be rejected by daily token quota."),
    postMessage(brain.baseUrl, "This concurrent turn must also be rejected."),
    postSidePrompt(brain.baseUrl, "This side prompt must also be rejected."),
  ]);

  for (const [label, result] of [
    ["turn A", turnA],
    ["turn B", turnB],
    ["side prompt", sidePrompt],
  ] as const) {
    run.check(result.status === 429, `${label} returns HTTP 429 at exhaustion`);
    run.check(result.body.error === "quota_exceeded", `${label} body.error=quota_exceeded`);
    run.check(result.body.code === "daily_tokens", `${label} body.code=daily_tokens`);
    run.check(Number(result.body.limit) === MAX_DAILY_TOKENS, `${label} reports configured limit`);
    run.check(Number(result.body.used) >= MAX_DAILY_TOKENS, `${label} reports used >= limit`, String(result.body.used));
  }

  const usageAfterReject = await getDailyTokenUsage(userId);
  const messagesAfterReject = await messageCount();
  run.check(usageAfterReject === usageAtBoundary, "rejected requests do not increase daily usage");
  run.check(messagesAfterReject === messagesAtBoundary, "rejected requests do not append transcript messages");
} finally {
  try {
    await run.cleanup();
  } finally {
    const report = await run.writeReport();
    console.log(`report: ${report}`);
  }
}

console.log("\nREAL TOKEN QUOTA E2E PASSED");
process.exit(0);
