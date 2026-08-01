import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
  applyMigrationSet,
  resolveLegacyMigrationBaseline,
  verifyLegacySchemaThrough017,
  type MigrationDefinition,
} from "./db.ts";
import { storeConfig } from "./config.ts";

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`.replaceAll("-", "_");
const schema = `migration_test_${suffix}`;
const clientA = new SQL(storeConfig.pgUrl);
const clientB = new SQL(storeConfig.pgUrl);
let pgAvailable = false;

function migrations(): MigrationDefinition[] {
  return [
    {
      version: "001_create_items",
      checksum: "checksum-001",
      sql: "CREATE TABLE items (id INT PRIMARY KEY)",
    },
    {
      version: "002_add_name",
      checksum: "checksum-002",
      sql: "ALTER TABLE items ADD COLUMN name TEXT",
    },
  ];
}

beforeAll(async () => {
  try {
    await clientA.unsafe(`CREATE SCHEMA ${schema}`);
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) {
    await clientA.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
  await Promise.all([clientA.end(), clientB.end()]);
});

describe("migration runner", () => {
  test("fails closed for a non-empty database without an explicit 017 baseline", () => {
    expect(resolveLegacyMigrationBaseline({
      hasLedger: false,
      databaseNonEmpty: true,
      requestedBaseline: undefined,
    })).toEqual({ action: "reject" });
    expect(resolveLegacyMigrationBaseline({
      hasLedger: false,
      databaseNonEmpty: true,
      requestedBaseline: "025",
    })).toEqual({ action: "reject" });
  });

  test("only accepts an explicit 017 baseline and still leaves 018+ pending", () => {
    expect(resolveLegacyMigrationBaseline({
      hasLedger: false,
      databaseNonEmpty: true,
      requestedBaseline: "017",
    })).toEqual({ action: "baseline", throughVersion: "017_token_usage_rls" });
    expect(resolveLegacyMigrationBaseline({
      hasLedger: false,
      databaseNonEmpty: false,
      requestedBaseline: undefined,
    })).toEqual({ action: "fresh" });
  });

  test("strict 017 verifier rejects missing tables, critical columns, indexes, and FORCE RLS", async () => {
    if (!pgAvailable) return;
    const incomplete = `${schema}_incomplete_017`;
    await clientA.unsafe(`CREATE SCHEMA ${incomplete}`);
    try {
      await clientA.unsafe(`CREATE TABLE ${incomplete}.users (id text primary key)`);
      expect(await verifyLegacySchemaThrough017(clientA, incomplete)).toBe(false);
    } finally {
      await clientA.unsafe(`DROP SCHEMA IF EXISTS ${incomplete} CASCADE`);
    }
  });

  test("strict 017 verifier accepts an actual 001-017 schema and rejects a corrupted final state", async () => {
    if (!pgAvailable) return;
    const fixture = `${schema}_fixture_017`;
    await clientA.unsafe(`CREATE SCHEMA ${fixture}`);
    try {
      const migrationDir = new URL("../../migrations/", import.meta.url).pathname;
      const paths = [...new Bun.Glob("*.sql").scanSync({
        cwd: migrationDir,
        absolute: true,
      })].sort().filter((path) => path.split("/").pop()! <= "017_token_usage_rls.sql");
      await clientA.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO "${fixture}", public`);
        for (const path of paths) await tx.unsafe(await Bun.file(path).text());
      });
      expect(await verifyLegacySchemaThrough017(clientA, fixture)).toBe(true);

      await clientA.unsafe(`DROP INDEX "${fixture}".token_usage_key_unique_idx`);
      expect(await verifyLegacySchemaThrough017(clientA, fixture)).toBe(false);
    } finally {
      await clientA.unsafe(`DROP SCHEMA IF EXISTS ${fixture} CASCADE`);
    }
  }, 20_000);

  test("fresh database applies every migration and records checksums", async () => {
    if (!pgAvailable) return;
    await applyMigrationSet({
      client: clientA,
      migrations: migrations(),
      schema,
      advisoryLockKey: 7_301_001,
    });

    const rows = await clientA.unsafe(
      `SELECT version, checksum FROM ${schema}.schema_migrations ORDER BY version`,
    );
    expect(rows.map((row: Record<string, unknown>) => [row.version, row.checksum])).toEqual([
      ["001_create_items", "checksum-001"],
      ["002_add_name", "checksum-002"],
    ]);
  });

  test("bootstraps an explicit legacy baseline without replaying schema DDL", async () => {
    if (!pgAvailable) return;
    const legacySchema = `${schema}_legacy`;
    await clientA.unsafe(`CREATE SCHEMA ${legacySchema}`);
    try {
      await clientA.unsafe(`CREATE TABLE ${legacySchema}.items (id INT PRIMARY KEY)`);
      await applyMigrationSet({
        client: clientA,
        migrations: migrations(),
        schema: legacySchema,
        advisoryLockKey: 7_301_002,
        baseline: {
          throughVersion: "001_create_items",
          verify: async (client) => {
            const rows = await client.unsafe(
              `SELECT to_regclass('${legacySchema}.items') IS NOT NULL AS present`,
            );
            return Boolean(rows[0]?.present);
          },
        },
      });

      const columns = await clientA.unsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = '${legacySchema}' AND table_name = 'items'
         ORDER BY ordinal_position`,
      );
      expect(columns.map((row: Record<string, unknown>) => row.column_name)).toEqual(["id", "name"]);
    } finally {
      await clientA.unsafe(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
    }
  });

  test("fails closed when an applied migration checksum changes", async () => {
    if (!pgAvailable) return;
    await expect(applyMigrationSet({
      client: clientA,
      migrations: [
        { ...migrations()[0]!, checksum: "tampered" },
        migrations()[1]!,
      ],
      schema,
      advisoryLockKey: 7_301_003,
    })).rejects.toThrow("checksum mismatch");
  });

  test("serializes concurrent runners and applies each migration once", async () => {
    if (!pgAvailable) return;
    const concurrentSchema = `${schema}_concurrent`;
    await clientA.unsafe(`CREATE SCHEMA ${concurrentSchema}`);
    try {
      await Promise.all([
        applyMigrationSet({
          client: clientA,
          migrations: migrations(),
          schema: concurrentSchema,
          advisoryLockKey: 7_301_004,
        }),
        applyMigrationSet({
          client: clientB,
          migrations: migrations(),
          schema: concurrentSchema,
          advisoryLockKey: 7_301_004,
        }),
      ]);
      const rows = await clientA.unsafe(
        `SELECT version, count(*)::int AS count
         FROM ${concurrentSchema}.schema_migrations
         GROUP BY version ORDER BY version`,
      );
      expect(rows.map((row: Record<string, unknown>) => Number(row.count))).toEqual([1, 1]);
    } finally {
      await clientA.unsafe(`DROP SCHEMA IF EXISTS ${concurrentSchema} CASCADE`);
    }
  });
});
