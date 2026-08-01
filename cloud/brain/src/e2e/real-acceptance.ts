import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Redis } from "ioredis";
import { sql } from "@piclaw-cloud/store/db";
import { deleteRemoteSandbox, deleteWorkspaceVolume, healthCheck } from "../sandbox/client.ts";
import { getAccessToken } from "../sandbox/auth.ts";
import { missingSandboxConfig } from "../sandbox/config.ts";
import { config } from "../config.ts";

export const REAL_E2E_PREFIX = "real-e2e";

export interface RealAcceptanceResult {
  name: string;
  ok: boolean;
  details?: string;
}

export interface RealAcceptanceReport {
  id: string;
  startedAt: string;
  finishedAt?: string;
  dependencies: Record<string, boolean>;
  resources: Record<string, string[]>;
  results: RealAcceptanceResult[];
  cleanup: { ok: boolean; errors: string[] };
}

export interface TrackedProcess {
  label: string;
  stop: () => Promise<void>;
}

function uniqueId(): string {
  return `${REAL_E2E_PREFIX}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

export class RealAcceptance {
  readonly id = uniqueId();
  readonly report: RealAcceptanceReport = {
    id: this.id,
    startedAt: new Date().toISOString(),
    dependencies: {},
    resources: {
      sessions: [],
      sandboxes: [],
      volumes: [],
      media: [],
      tasks: [],
      users: [],
      apiKeys: [],
      usageUsers: [],
      processes: [],
    },
    results: [],
    cleanup: { ok: true, errors: [] },
  };

  private readonly processes: TrackedProcess[] = [];

  session(suffix: string): string {
    const id = `${this.id}-${suffix}`;
    this.report.resources.sessions.push(id);
    return id;
  }

  addResource(kind: keyof RealAcceptanceReport["resources"], id: string): void {
    if (!this.report.resources[kind].includes(id)) this.report.resources[kind].push(id);
  }

  trackProcess(label: string, stop: () => Promise<void>): void {
    this.processes.push({ label, stop });
    this.addResource("processes", label);
  }

  check(condition: boolean, name: string, details?: string): void {
    this.report.results.push({ name, ok: condition, details });
    console.log(`  ${condition ? "✅" : "❌"} ${name}${details ? ` — ${details}` : ""}`);
    if (!condition) throw new Error(`FAILED: ${name}${details ? ` (${details})` : ""}`);
  }

  async preflight(
    base: string | null,
    options: { sandbox?: boolean; requireLlm?: boolean; skipBrain?: boolean } = {},
  ): Promise<void> {
    if (!options.skipBrain) {
      if (!base) throw new Error("Brain base URL required unless skipBrain is set");
      const brain = await fetch(`${base}/health`).then((res) => res.ok).catch(() => false);
      this.report.dependencies.brain = brain;
      this.check(brain, "Brain health");
    }

    const pg = await sql`SELECT 1 AS ok`.then(() => true).catch(() => false);
    this.report.dependencies.postgres = pg;
    this.check(pg, "PostgreSQL connectivity");

    const redisClient = new Redis(config.redisUrl);
    const redis = await redisClient.ping().then((reply) => reply === "PONG").catch(() => false);
    redisClient.disconnect();
    this.report.dependencies.redis = redis;
    this.check(redis, "Redis connectivity");

    if (options.sandbox) {
      const missing = missingSandboxConfig();
      const cube = missing.length === 0 && (await healthCheck()).ok;
      this.report.dependencies.cubeSandbox = cube;
      this.check(cube, "CubeSandbox health", missing.length ? missing.join(", ") : undefined);
      const ops = await getAccessToken().then(() => true).catch(() => false);
      this.report.dependencies.cubeOpsAuth = ops;
      this.check(ops, "CubeSandbox Ops authentication");
    }

    if (options.requireLlm) {
      // The credential belongs to the running Brain process and must not be
      // copied into the verifier. A successful streamed completion is the
      // authoritative proof, recorded by the calling scenario.
      this.report.dependencies.realLlmConfiguration = true;
    }
  }

  async cleanup(): Promise<void> {
    const errors: string[] = [];

    for (const proc of [...this.processes].reverse()) {
      try {
        await proc.stop();
      } catch {
        errors.push(`process:${proc.label}`);
      }
    }

    for (const sandboxId of this.report.resources.sandboxes) {
      if (!(await deleteRemoteSandbox(sandboxId).catch(() => false))) {
        errors.push(`sandbox:${sandboxId}`);
      }
    }
    for (const volumeId of this.report.resources.volumes) {
      if (!(await deleteWorkspaceVolume(volumeId).catch(() => false))) {
        errors.push(`volume:${volumeId}`);
      }
    }
    for (const mediaId of this.report.resources.media) {
      await sql`DELETE FROM media WHERE id = ${Number(mediaId)}`.catch(() => errors.push(`media:${mediaId}`));
    }
    for (const taskId of this.report.resources.tasks) {
      await sql`DELETE FROM scheduled_tasks WHERE id = ${taskId}`.catch(() => errors.push(`task:${taskId}`));
    }
    for (const sessionId of this.report.resources.sessions) {
      await sql`DELETE FROM autoresearch_runs WHERE session_id = ${sessionId} OR execution_session_id = ${sessionId}`
        .catch(() => errors.push(`autoresearch:${sessionId}`));
      await sql`DELETE FROM subagent_messages WHERE run_id IN (
        SELECT id FROM subagent_runs WHERE session_id = ${sessionId}
      )`.catch(() => errors.push(`subagent-messages:${sessionId}`));
      await sql`DELETE FROM subagent_runs WHERE session_id = ${sessionId}`
        .catch(() => errors.push(`subagent-runs:${sessionId}`));
      await sql`DELETE FROM token_usage WHERE session_id = ${sessionId}`
        .catch(() => errors.push(`token-usage:${sessionId}`));
      await sql`DELETE FROM messages WHERE session_id = ${sessionId}`
        .catch(() => errors.push(`messages:${sessionId}`));
      await sql`DELETE FROM session_cursors WHERE session_id = ${sessionId}`
        .catch(() => errors.push(`cursor:${sessionId}`));
      await sql`DELETE FROM sessions WHERE id = ${sessionId}`.catch(() => errors.push(`session:${sessionId}`));
    }
    for (const userId of this.report.resources.usageUsers) {
      await sql`DELETE FROM user_daily_usage WHERE user_id = ${userId}`
        .catch(() => errors.push(`usage:${userId}`));
    }
    for (const userId of this.report.resources.users) {
      await sql`DELETE FROM user_daily_usage WHERE user_id = ${userId}`
        .catch(() => errors.push(`usage:${userId}`));
      await sql`DELETE FROM api_keys WHERE user_id = ${userId}`.catch(() => errors.push(`api-keys:${userId}`));
      await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => errors.push(`user:${userId}`));
    }
    this.report.cleanup = { ok: errors.length === 0, errors };
    this.report.finishedAt = new Date().toISOString();
    if (errors.length > 0) throw new Error(`real acceptance cleanup failed: ${errors.join(", ")}`);
  }

  async writeReport(directory = "generated/real-acceptance"): Promise<string> {
    const path = join(directory, `${this.id}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(this.report, null, 2)}\n`);
    return path;
  }
}
