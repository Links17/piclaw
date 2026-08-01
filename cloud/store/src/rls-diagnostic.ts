/**
 * Diagnose whether transaction-local RLS context is visible to the query path.
 *
 * This intentionally does not change production request handling. It documents
 * the connection-affinity requirement before `setUserContext` is used for RLS.
 */
import { sql } from "./db.ts";

const userId = `rls-diagnostic-${Date.now()}`;

try {
  const outsideBefore = await sql`SELECT current_setting('app.user_id', true) AS user_id`;
  const transactionResult = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    const inside = await tx`SELECT current_setting('app.user_id', true) AS user_id`;
    const callbackThroughGlobalSql = await sql`SELECT current_setting('app.user_id', true) AS user_id`;
    return {
      inside: String(inside[0]?.user_id ?? ""),
      callbackThroughGlobalSql: String(callbackThroughGlobalSql[0]?.user_id ?? ""),
    };
  });
  const outsideAfter = await sql`SELECT current_setting('app.user_id', true) AS user_id`;

  console.log(JSON.stringify({
    userId,
    outsideBefore: String(outsideBefore[0]?.user_id ?? ""),
    transaction: transactionResult,
    outsideAfter: String(outsideAfter[0]?.user_id ?? ""),
    safeForRequestScopedRls:
      transactionResult.inside === userId &&
      transactionResult.callbackThroughGlobalSql === userId &&
      String(outsideAfter[0]?.user_id ?? "") === "",
  }, null, 2));
} finally {
  await sql.close();
}
