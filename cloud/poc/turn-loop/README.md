# PoC 1 — stateless turn loop (brain service core)

Validates the serverless design's session core ([docs/cloud/serverless-design.md](../../../docs/cloud/serverless-design.md) §6,
[implementation plan](../../../docs/cloud/implementation-plan.md) Phase 0):

- **Per-session mutual exclusion** via PG advisory locks (replaces the in-memory `AgentQueue` lane)
- **Single-SQL turn state machine** ported from `runtime/src/db/chat-cursors.ts` to Postgres
- **Token streaming** fan-out through Redis pub/sub → SSE (any replica can serve the stream)
- **Follow-up queue** in `session_cursors.queued_followups` (jsonb), drained under the lock
- **Crash recovery**: SIGKILL a replica mid-turn; the peer's sweep re-runs the turn

## Prerequisites

Local docker services (already running on this machine):

- Postgres 16 at `localhost:25432` (user/pass `sensecraft`), database `piclaw_cloud_poc`
- Redis 7 at `localhost:26379`, **db 5**

Override with `POC_PG_URL` / `POC_REDIS_URL` if they move.

## Run

```bash
bun install
bun run schema          # apply schema.sql (idempotent; main.ts also does this)
bun run scenario        # spawns two replicas and runs all 4 verification scenarios
```

Manual mode:

```bash
POC_PORT=7801 POC_REPLICA_ID=A bun run replica
POC_PORT=7802 POC_REPLICA_ID=B bun run replica

curl -X POST localhost:7801/sessions -d '{"title":"demo"}'
curl -N localhost:7802/sessions/<id>/stream          # SSE via the *other* replica
curl -X POST localhost:7801/sessions/<id>/messages -d '{"content":"hello"}'
```

## Mock LLM pacing

The default provider is a deterministic mock; the user message prefix controls pacing:

| prefix   | tokens x delay | turn length |
|----------|----------------|-------------|
| `slow`   | 40 x 500ms     | ~20s (kill window) |
| `medium` | 20 x 150ms     | ~3s |
| (other)  | 8 x 30ms       | fast |

Set `POC_OPENAI_BASE_URL` / `POC_OPENAI_API_KEY` / `POC_OPENAI_MODEL` to stream from a real
OpenAI-compatible endpoint; per-turn usage (incl. `cached_tokens`) lands in the `turn_usage` table
for the KV-cache measurement.
