import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTempWorkspace, importFresh } from "./helpers.js";

test("dream token defaults and auto gate follow nightly cadence", async () => {
  const dream = await importFresh<typeof import("../src/dream.js")>("../src/dream.js");

  expect(dream.parseDreamPromptToken("dream")).toEqual({ matched: true, mode: "manual", days: 7 });
  expect(dream.parseDreamPromptToken("dream 0")).toEqual({ matched: true, mode: "manual", days: 1 });
  expect(dream.parseDreamPromptToken("auto dream")).toEqual({ matched: true, mode: "auto", days: 2 });
  expect(dream.parseDreamPromptToken("auto dream 0")).toEqual({ matched: true, mode: "auto", days: 1 });
  expect(dream.parseDreamPromptToken("auto dream 5")).toEqual({ matched: true, mode: "auto", days: 5 });

  expect(dream.shouldRunAutoDream(null, null)).toEqual({ ok: true, reason: null });
  expect(dream.shouldRunAutoDream("2026-04-06T23:22:39.203Z", 0)).toEqual({ ok: false, reason: "No sessions since last consolidation." });
  expect(dream.shouldRunAutoDream("2026-04-06T23:22:39.203Z", 0, true)).toEqual({ ok: true, reason: null });
  expect(dream.shouldRunAutoDream("2026-04-06T23:22:39.203Z", 1)).toEqual({ ok: true, reason: null });
});

test("Dream scheduler uses typed restart configuration for cron and model", () => {
  const workspace = createTempWorkspace("piclaw-dream-scheduler-config-");
  try {
    mkdirSync(join(workspace.workspace, ".seeed"), { recursive: true });
    writeFileSync(join(workspace.workspace, ".seeed", "config.json"), JSON.stringify({
      domains: {
        dream: {
          cron: "45 3 * * *",
          backupKeep: 6,
          model: "github-copilot/gpt-5-mini",
          agentTimeoutMs: 180000,
        },
      },
    }), "utf8");
    const script = `
      import { initDatabase } from "./src/db.js";
      import { DREAM_TASK_CRON, ensureDreamTask } from "./src/dream.js";
      initDatabase();
      const task = ensureDreamTask("web:default");
      console.log(JSON.stringify({ cron: DREAM_TASK_CRON, schedule: task?.schedule_value, model: task?.model }));
    `;
    const proc = Bun.spawnSync(["bun", "--no-env-file", "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "/tmp",
        PICLAW_WORKSPACE: workspace.workspace,
        PICLAW_STORE: workspace.store,
        PICLAW_DATA: workspace.data,
        PICLAW_DB_IN_MEMORY: "1",
        PICLAW_DREAM_CRON: undefined,
        PICLAW_DREAM_BACKUP_KEEP: undefined,
        PICLAW_DREAM_MODEL: undefined,
        PICLAW_DREAM_AGENT_TIMEOUT_MS: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, proc.stderr.toString() || proc.stdout.toString()).toBe(0);
    const outputLine = proc.stdout.toString().trim().split("\n").filter(Boolean).at(-1) || "";
    expect(JSON.parse(outputLine)).toEqual({
      cron: "45 3 * * *",
      schedule: "45 3 * * *",
      model: "github-copilot/gpt-5-mini",
    });
  } finally {
    workspace.cleanup();
  }
});

test("runDreamMaintenance skips when a live Dream lock belongs to an inaccessible process", async () => {
  const workspace = createTempWorkspace("piclaw-dream-lock-");
  try {
    const lockPath = join(workspace.workspace, "notes", "memory", ".dream.lock");
    mkdirSync(join(workspace.workspace, "notes", "memory"), { recursive: true });
    writeFileSync(lockPath, "424242", "utf8");

    const script = `
      import { initDatabase } from "./src/db.js";
      import { runDreamMaintenance } from "./src/dream.js";

      initDatabase();
      process.kill = ((pid) => {
        const error = new Error(\`operation not permitted for pid \${pid}\`);
        error.code = "EPERM";
        throw error;
      });

      const result = await runDreamMaintenance({ chatJid: "web:default", days: 1 });
      if (!result.skipped || !String(result.skip_reason || "").includes("Dream already running")) {
        process.exit(1);
      }
      process.exit(0);
    `;

    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PICLAW_WORKSPACE: workspace.workspace,
        PICLAW_STORE: workspace.store,
        PICLAW_DATA: workspace.data,
        PICLAW_DB_IN_MEMORY: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode, proc.stderr.toString() || proc.stdout.toString()).toBe(0);
  } finally {
    workspace.cleanup();
  }
});
