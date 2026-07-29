import { config } from "./config.ts";
import { applySchema } from "./db.ts";
import { startServer } from "./server.ts";
import { sweepInflight } from "./turn.ts";

await applySchema();
const server = startServer();
console.log(`[${config.replicaId}] listening on :${server.port}`);

// Recovery sweep loop — every replica runs it; the advisory lock arbitrates.
setInterval(() => {
  sweepInflight().catch((error) => {
    console.error(`[${config.replicaId}] sweep error:`, error);
  });
}, config.sweepIntervalMs);
