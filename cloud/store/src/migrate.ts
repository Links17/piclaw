import { applyMigrations } from "./db.ts";

await applyMigrations();
console.log("migrations applied (001_core.sql)");
await import("./db.ts").then((m) => m.sql.end());
