import "./bootstrap-config.ts";
import { initializeMcpClients } from "./mcp/client.ts";
import { seedSystemSkills } from "./skills/seed.ts";
import { config } from "./config.ts";
import { initKernelRuntime } from "./kernel/runtime.ts";
import { bootstrapSchema, startRecoverySweep, startServer } from "./server.ts";

await bootstrapSchema();
const seeded = await seedSystemSkills();
if (seeded > 0) {
  console.log(`[@piclaw-cloud/brain ${config.replicaId}] seeded ${seeded} system skill(s)`);
}
await initializeMcpClients();
if (config.openaiBaseUrl && config.openaiApiKey) {
  await initKernelRuntime();
}
const server = startServer();
startRecoverySweep();
if (config.openaiBaseUrl && config.openaiApiKey) {
  console.log(
    `[@piclaw-cloud/brain ${config.replicaId}] openai configured: ${config.openaiBaseUrl}, model=${config.openaiModel}`,
  );
} else {
  console.warn(
    `[@piclaw-cloud/brain ${config.replicaId}] openai NOT configured — copy cloud/brain.config.example.json to cloud/brain.config.json and set openai.baseUrl + openai.apiKey`,
  );
}
console.log(`[@piclaw-cloud/brain ${config.replicaId}] listening on :${server.port}`);
