import "./bootstrap-config.ts";
import { ensureDreamTask } from "./dream/ensure-task.ts";
import { initializeMcpClients } from "./mcp/client.ts";
import { seedSystemSkills } from "./skills/seed.ts";
import { config } from "./config.ts";
import { initKernelRuntime, isKernelAvailable, isKernelConfigured } from "./kernel/runtime.ts";
import { isLlmMockEnabled } from "./llm.ts";
import { bootstrapSchema, startRecoverySweep, startServer } from "./server.ts";

await bootstrapSchema();
await ensureDreamTask().catch((error) => {
  console.warn(`[@piclaw-cloud/brain ${config.replicaId}] dream task seed failed:`, error);
});
const seeded = await seedSystemSkills();
if (seeded > 0) {
  console.log(`[@piclaw-cloud/brain ${config.replicaId}] seeded ${seeded} system skill(s)`);
}
await initializeMcpClients();
if (isKernelAvailable()) {
  await initKernelRuntime();
}
const server = startServer();
startRecoverySweep();
if (isKernelConfigured()) {
  console.log(
    `[@piclaw-cloud/brain ${config.replicaId}] openai configured: ${config.openaiBaseUrl}, model=${config.openaiModel}`,
  );
} else if (isLlmMockEnabled()) {
  console.log(`[@piclaw-cloud/brain ${config.replicaId}] mock LLM enabled (CLOUD_LLM_MOCK=1)`);
} else {
  console.warn(
    `[@piclaw-cloud/brain ${config.replicaId}] openai NOT configured — copy cloud/brain.config.example.json to cloud/brain.config.json and set openai.baseUrl + openai.apiKey`,
  );
}
console.log(`[@piclaw-cloud/brain ${config.replicaId}] listening on :${server.port}`);
