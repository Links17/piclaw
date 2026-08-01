import { SQL } from "bun";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { storeConfig } from "./config.ts";

export const sql = new SQL(storeConfig.pgUrl);

export interface RoundtripCounter {
  count: number;
}

export function newCounter(): RoundtripCounter {
  return { count: 0 };
}

export function counted(counter?: RoundtripCounter) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (counter) counter.count += 1;
    return sql(strings, ...values);
  };
}

export interface MigrationDefinition {
  version: string;
  checksum: string;
  sql: string;
}

export interface MigrationBaseline {
  throughVersion: string;
  verify: (client: SQL) => Promise<boolean>;
}

const MIGRATION_ADVISORY_LOCK_KEY = 0x5049434c4157;

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid SQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function migrationVersion(path: string): string {
  return basename(path, ".sql");
}

async function loadMigrations(): Promise<MigrationDefinition[]> {
  const migrationsDir = new URL("../../migrations/", import.meta.url).pathname;
  const entries = [...new Bun.Glob("*.sql").scanSync({ cwd: migrationsDir, absolute: true })].sort();
  return Promise.all(entries.map(async (path) => {
    const ddl = await Bun.file(path).text();
    return {
      version: migrationVersion(path),
      checksum: createHash("sha256").update(ddl).digest("hex"),
      sql: ddl,
    };
  }));
}

export function resolveLegacyMigrationBaseline(input: {
  hasLedger: boolean;
  databaseNonEmpty: boolean;
  requestedBaseline?: string;
}): { action: "fresh" } | { action: "reject" } | {
  action: "baseline";
  throughVersion: "017_token_usage_rls";
} {
  if (input.hasLedger) return { action: "fresh" };
  if (!input.databaseNonEmpty) return { action: "fresh" };
  if (input.requestedBaseline === "017") {
    return { action: "baseline", throughVersion: "017_token_usage_rls" };
  }
  return { action: "reject" };
}

const LEGACY_017_TABLES = [
  "users", "sessions", "messages", "session_cursors", "token_usage", "scheduled_tasks",
  "subagent_runs", "api_keys", "user_daily_usage", "subagent_messages", "skills",
  "task_run_logs", "media", "message_media", "web_push_vapid_keys",
  "web_push_subscriptions", "session_recordings", "session_recording_events", "user_keychain",
  "autoresearch_runs", "cloud_migration_markers", "session_compactions",
  "session_compaction_backoffs",
] as const;
const LEGACY_017_COLUMNS = [
  ["sessions", "mode"], ["sessions", "todos"], ["sessions", "skills"],
  ["sessions", "mcp_servers"], ["sessions", "workspace_volume_id"],
  ["sessions", "terminal_pid"], ["sessions", "parent_session_id"],
  ["sessions", "forked_from_message_id"], ["sessions", "inherited_message_count"],
  ["users", "preferences"], ["media", "object_key"], ["media", "thumbnail_object_key"],
  ["media", "object_size"], ["token_usage", "user_id"], ["token_usage", "usage_key"],
  ["token_usage", "usage_source"], ["token_usage", "reasoning_tokens"],
  ["token_usage", "total_tokens"],
] as const;
const LEGACY_017_INDEXES = [
  "token_usage_key_unique_idx", "token_usage_session_source_idx", "token_usage_user_date_idx",
  "session_compactions_latest_idx", "autoresearch_runs_live_session_idx",
] as const;
const LEGACY_017_FORCE_RLS_TABLES = [
  "sessions", "messages", "session_cursors", "token_usage", "scheduled_tasks",
  "subagent_runs", "api_keys", "user_daily_usage", "session_compactions",
  "session_compaction_backoffs",
] as const;

export async function verifyLegacySchemaThrough017(
  client: SQL,
  schema = "public",
): Promise<boolean> {
  const [tables, columns, indexes, forced, forbidden] = await Promise.all([
    client.unsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    ),
    client.unsafe(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`,
      [schema],
    ),
    client.unsafe(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [schema],
    ),
    client.unsafe(
      `SELECT c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relforcerowsecurity`,
      [schema],
    ),
    client.unsafe(
      `SELECT
         to_regclass(format('%I.session_artifacts', $1::text)) IS NOT NULL AS session_artifacts,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'sessions' AND column_name = 'archived_at'
         ) AS archived_at,
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'media' AND column_name IN ('data', 'thumbnail')
         ) AS media_bytes`,
      [schema],
    ),
  ]);
  const presentTables = new Set(tables.map((row: Record<string, unknown>) => String(row.table_name)));
  const presentColumns = new Set(columns.map(
    (row: Record<string, unknown>) => `${row.table_name}.${row.column_name}`,
  ));
  const presentIndexes = new Set(indexes.map((row: Record<string, unknown>) => String(row.indexname)));
  const forcedTables = new Set(forced.map((row: Record<string, unknown>) => String(row.relname)));
  const missing = [
    ...LEGACY_017_TABLES.filter((name) => !presentTables.has(name)).map((name) => `table:${name}`),
    ...LEGACY_017_COLUMNS.filter(([table, column]) =>
      !presentColumns.has(`${table}.${column}`)
    ).map(([table, column]) => `column:${table}.${column}`),
    ...LEGACY_017_INDEXES.filter((name) => !presentIndexes.has(name)).map((name) => `index:${name}`),
    ...LEGACY_017_FORCE_RLS_TABLES.filter((name) =>
      !forcedTables.has(name)
    ).map((name) => `force_rls:${name}`),
  ];
  const invalidFinalState = forbidden[0] && [
    forbidden[0].session_artifacts ? "forbidden:session_artifacts" : "",
    forbidden[0].archived_at ? "forbidden:sessions.archived_at" : "",
    forbidden[0].media_bytes ? "forbidden:media.data_or_thumbnail" : "",
  ].filter(Boolean);
  missing.push(...(invalidFinalState || []));
  if (missing.length > 0) {
    console.error(JSON.stringify({
      level: "error",
      event: "migration_017_baseline_verification_failed",
      schema,
      missing,
    }));
    return false;
  }
  return true;
}

export async function applyMigrationSet(options: {
  client: SQL;
  migrations: MigrationDefinition[];
  schema?: string;
  advisoryLockKey?: number;
  baseline?: MigrationBaseline;
}): Promise<void> {
  const schema = options.schema ?? "public";
  const schemaIdentifier = quoteIdentifier(schema);
  const lockKey = options.advisoryLockKey ?? MIGRATION_ADVISORY_LOCK_KEY;
  const client = await options.client.reserve();
  await client`SELECT pg_advisory_lock(${lockKey})`;
  try {
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS ${schemaIdentifier}.schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const appliedRows = await client.unsafe(
      `SELECT version, checksum FROM ${schemaIdentifier}.schema_migrations ORDER BY version`,
    );
    const applied = new Map(
      appliedRows.map((row: Record<string, unknown>) => [String(row.version), String(row.checksum)]),
    );
    for (const migration of options.migrations) {
      const checksum = applied.get(migration.version);
      if (checksum != null && checksum !== migration.checksum) {
        throw new Error(
          `migration ${migration.version} checksum mismatch: expected ${checksum}, got ${migration.checksum}`,
        );
      }
    }

    if (applied.size === 0 && options.baseline) {
      const verified = await options.baseline.verify(client);
      if (!verified) {
        throw new Error(
          `migration baseline ${options.baseline.throughVersion} verification failed`,
        );
      }
      const baselineMigrations = options.migrations.filter(
        (migration) => migration.version <= options.baseline!.throughVersion,
      );
      await client.begin(async (tx) => {
        for (const migration of baselineMigrations) {
          await tx.unsafe(
            `INSERT INTO ${schemaIdentifier}.schema_migrations (version, checksum)
             VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
            [migration.version, migration.checksum],
          );
        }
      });
      for (const migration of baselineMigrations) applied.set(migration.version, migration.checksum);
    }

    for (const migration of options.migrations) {
      if (applied.has(migration.version)) continue;
      await client.begin(async (tx) => {
        if (schema !== "public") {
          await tx.unsafe(`SET LOCAL search_path TO ${schemaIdentifier}, public`);
        }
        await tx.unsafe(migration.sql);
        await tx.unsafe(
          `INSERT INTO ${schemaIdentifier}.schema_migrations (version, checksum)
           VALUES ($1, $2)`,
          [migration.version, migration.checksum],
        );
      });
      applied.set(migration.version, migration.checksum);
    }
  } finally {
    try {
      await client`SELECT pg_advisory_unlock(${lockKey})`;
    } finally {
      client.release();
    }
  }
}

export async function applyMigrations(): Promise<void> {
  const migrations = await loadMigrations();
  const hasLedger = await sql`
    SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`;
  const nonEmpty = await sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND c.relname <> 'schema_migrations'
    ) AS present`;
  const baseline = resolveLegacyMigrationBaseline({
    hasLedger: Boolean(hasLedger[0]?.present),
    databaseNonEmpty: Boolean(nonEmpty[0]?.present),
    requestedBaseline: process.env.CLOUD_MIGRATION_BASELINE?.trim(),
  });
  if (baseline.action === "reject") {
    throw new Error(
      "non-empty database has no migration ledger; set CLOUD_MIGRATION_BASELINE=017 only for a verified legacy 001-017 schema",
    );
  }
  await applyMigrationSet({
    client: sql,
    migrations,
    advisoryLockKey: MIGRATION_ADVISORY_LOCK_KEY,
    ...(baseline.action === "baseline"
      ? {
          baseline: {
            throughVersion: baseline.throughVersion,
            verify: verifyLegacySchemaThrough017,
          },
        }
      : {}),
  });
}
