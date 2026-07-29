import { sql } from "./db.ts";

/** Set RLS user scope for the current connection (transaction-local). */
export async function setUserContext(userId: string): Promise<void> {
  await sql`SELECT set_config('app.user_id', ${userId}, true)`;
}

export async function withUserContext<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return fn();
  });
}
