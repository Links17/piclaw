import "./bootstrap-config.ts";
import { config } from "./config.ts";
import { bootstrapSchema, startRecoverySweep, startServer } from "./server.ts";

await bootstrapSchema();
const server = startServer();
startRecoverySweep();
console.log(`[@piclaw-cloud/brain ${config.replicaId}] listening on :${server.port}`);
