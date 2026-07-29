import { applyMigrations } from "./db.ts";

await applyMigrations();
console.log("migrations applied");
await import("./db.ts").then((m) => m.sql.end());
