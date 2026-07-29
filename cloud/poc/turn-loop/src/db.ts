/**
 * Postgres access via Bun's built-in SQL client, with per-turn roundtrip
 * counting so PoC 1 can report how chatty a single turn is.
 */
import { SQL } from "bun";
import { config } from "./config.ts";

export const sql = new SQL(config.pgUrl);

/** Mutable counter attached to a turn; incremented by counted queries. */
export interface RoundtripCounter {
  count: number;
}

export function newCounter(): RoundtripCounter {
  return { count: 0 };
}

/**
 * Run a query through the shared pool, counting it against a turn if given.
 * Usage: counted(ctr)`SELECT ...`
 */
export function counted(counter?: RoundtripCounter) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (counter) counter.count += 1;
    return sql(strings, ...values);
  };
}

export async function applySchema(): Promise<void> {
  const schemaPath = new URL("../schema.sql", import.meta.url).pathname;
  const ddl = await Bun.file(schemaPath).text();
  await sql.unsafe(ddl);
}
