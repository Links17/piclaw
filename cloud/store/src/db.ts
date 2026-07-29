import { SQL } from "bun";
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

export async function applyMigrations(): Promise<void> {
  const migrationPath = new URL("../../migrations/001_core.sql", import.meta.url).pathname;
  const ddl = await Bun.file(migrationPath).text();
  await sql.unsafe(ddl);
}
