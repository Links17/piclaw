import { applySchema, sql } from "./db.ts";

await applySchema();
console.log("schema applied");
await sql.end();
