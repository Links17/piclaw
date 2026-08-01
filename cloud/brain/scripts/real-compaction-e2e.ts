/**
 * Real LLM persistent compaction acceptance.
 *
 * Uses a deliberately small model context window and a low compaction threshold,
 * then verifies progressive persistent summaries, one attributed usage row per
 * unique compaction boundary, and a successful follow-up that reuses compacted
 * history.
 */
import { sql } from "@piclaw-cloud/store/db";
import { RealAcceptance } from "../src/e2e/real-acceptance.ts";
import { spawnBrain } from "../src/e2e/spawn-brain.ts";

const BASE_CONFIG = new URL("../../brain.config.llm-e2e.json", import.meta.url).pathname;
const API_KEY = process.env.CLOUD_OPENAI_API_KEY
  || await Bun.file(new URL("../../brain.config.json", import.meta.url).pathname)
    .json()
    .then((cfg: { openai?: { apiKey?: string } }) => cfg.openai?.apiKey ?? "");
const PORT = Number(process.env.CLOUD_COMPACTION_PORT || 17931);

const run = new RealAcceptance();
const sessionId = run.session("compaction");

async function postMessage(base: string, content: string): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${base}/agent/default/message?chat_jid=${encodeURIComponent(sessionId)}&wait=1`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok) throw new Error(`message failed ${response.status}: ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

if (!API_KEY || API_KEY === "sk-your-key-here") {
  console.error("Missing CLOUD_OPENAI_API_KEY / brain.config.json openai.apiKey");
  process.exit(2);
}

try {
  await run.preflight(null, { requireLlm: true, skipBrain: true });
  const brain = await spawnBrain({
    port: PORT,
    replicaId: `${run.id}-compaction`,
    baseConfigPath: BASE_CONFIG,
    apiKey: API_KEY,
    overrides: {
      sandbox: { enabled: false },
      limits: { maxDailyTokensPerUser: 5_000_000 },
      openai: {
        model: "gpt-5.5",
        contextWindow: 8_000,
        maxTokens: 1_024,
      },
    },
  });
  run.trackProcess("compaction-brain", brain.stop);

  const created = await fetch(`${brain.baseUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: sessionId, title: "real compaction acceptance" }),
  });
  run.check(created.ok, "creates compaction acceptance session");
  await sql`
    UPDATE users
    SET preferences = COALESCE(preferences, '{}'::jsonb)
      || '{"compactionThresholdPercent":50,"autoCompactionEnabled":true}'::jsonb
    WHERE id = 'default-user'`;

  const constraint = "CRITICAL_CONSTRAINT_7F9A: never delete the blue migration marker.";
  const payload = Array.from({ length: 80 }, (_, index) =>
    `Context record ${index}: preserve exact migration decisions, paths, failures, approvals, rollback rules, and ownership boundaries.`
  ).join(" ");
  await postMessage(brain.baseUrl, `${constraint}\n${payload}\nReply only ACK_ONE.`);
  for (let index = 2; index <= 5; index += 1) {
    await postMessage(
      brain.baseUrl,
      `Continuation ${index}. ${payload}\nKeep every prior constraint and reply only ACK_${index}.`,
    );
  }

  const compactions = await sql`
    SELECT summary, compacted_through_message_id
    FROM session_compactions
    WHERE session_id = ${sessionId}
    ORDER BY compacted_through_message_id`;
  const contextResponse = await fetch(
    `${brain.baseUrl}/agent/context?chat_jid=${encodeURIComponent(sessionId)}`,
  ).then((response) => response.json()).catch(() => ({})) as Record<string, unknown>;
  const stored = await sql`
    SELECT COUNT(*)::int AS count, COALESCE(SUM(length(content)), 0)::int AS chars
    FROM messages WHERE session_id = ${sessionId}`;
  const context = contextResponse.context as Record<string, unknown> | undefined;
  const postTokens = Number(context?.used ?? contextResponse.tokens ?? Number.NaN);
  const contextWindow = Number(context?.total ?? contextResponse.context_window ?? Number.NaN);
  const reserveTokens = Math.max(1_024, Math.round(contextWindow * 0.5));
  run.check(
    compactions.length >= 1,
    "creates at least one persistent compaction summary",
    JSON.stringify({ count: compactions.length, contextResponse, stored: stored[0] }),
  );
  run.check(
    Number.isFinite(postTokens)
      && Number.isFinite(contextWindow)
      && postTokens <= contextWindow - reserveTokens,
    "post-compaction context stays within the provider budget",
    JSON.stringify({ postTokens, contextWindow, reserveTokens }),
  );
  const boundaries = compactions.map((row: Record<string, unknown>) =>
    Number(row.compacted_through_message_id)
  );
  run.check(
    new Set(boundaries).size === boundaries.length
      && boundaries.every((boundary: number, index: number) =>
        index === 0 || boundary > boundaries[index - 1]!
      ),
    "progressive compaction boundaries are unique and strictly increasing",
    JSON.stringify(boundaries),
  );
  run.check(
    String(compactions.at(-1)?.summary ?? "").includes("CRITICAL_CONSTRAINT_7F9A"),
    "latest persistent summary preserves the critical constraint",
  );
  const usageRows = await sql`
    SELECT count(*)::int AS n, count(DISTINCT operation_id)::int AS operations
    FROM token_usage
    WHERE session_id = ${sessionId}
      AND usage_source = 'compaction'
      AND stage = 'summary'`;
  run.check(
    Number(usageRows[0]?.operations ?? 0) === compactions.length
      && Number(usageRows[0]?.n ?? 0) >= compactions.length,
    "attributes attempt usage to each persistent compaction without boundary double-counting",
    JSON.stringify({
      usageRows: Number(usageRows[0]?.n ?? 0),
      operations: Number(usageRows[0]?.operations ?? 0),
      compactions: compactions.length,
    }),
  );

  const followup = await postMessage(
    brain.baseUrl,
    "What exact CRITICAL_CONSTRAINT_7F9A must still be followed? Reply with the complete constraint.",
  );
  run.check(followup.outcome === "ran", "follow-up succeeds using persisted compacted context");
} finally {
  try {
    await run.cleanup();
  } finally {
    const report = await run.writeReport();
    console.log(`report: ${report}`);
  }
}

console.log("\nREAL COMPACTION E2E PASSED");
