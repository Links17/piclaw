/**
 * Deterministic provider/model routing acceptance test.
 *
 * This uses local OpenAI-compatible HTTP fixtures only to prove routing.
 * It is not evidence that a real external model is available.
 */
import {
  createProviderRuntime,
  resolveProviderModel,
  type ProviderRegistryEntry,
} from "../src/kernel/provider-registry.ts";

const requests: Array<{ provider: string; path: string; authorization: string | null; model: string }> = [];
const servers: Bun.Server<undefined>[] = [];

function startFixture(provider: string, expectedKey: string): string {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.json().catch(() => ({})) as { model?: string };
      requests.push({
        provider,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        model: String(body.model ?? ""),
      });
      if (request.headers.get("authorization") !== `Bearer ${expectedKey}`) {
        return Response.json({ error: { message: "invalid credential" } }, { status: 401 });
      }
      if (url.pathname !== "/v1/chat/completions") {
        return Response.json({ error: { message: "wrong endpoint" } }, { status: 404 });
      }
      return new Response([
        "data: " + JSON.stringify({
          id: `fixture-${provider}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: `fixture:${provider}` }, finish_reason: null }],
        }),
        "",
        "data: " + JSON.stringify({
          id: `fixture-${provider}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        "",
        "data: [DONE]",
        "",
      ].join("\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/v1`;
}

async function consume(runtime: Awaited<ReturnType<typeof createProviderRuntime>>) {
  const stream = runtime.models.streamSimple(runtime.model, {
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() }],
  } as never, { apiKey: runtime.apiKey });
  for await (const event of stream) {
    if (event.type === "error") throw new Error("provider request failed");
    if (event.type === "done") break;
  }
}

const primaryUrl = startFixture("primary", "primary-key");
const secondaryUrl = startFixture("secondary", "secondary-key");
const providers: ProviderRegistryEntry[] = [
  {
    id: "primary",
    name: "Primary fixture",
    baseUrl: primaryUrl,
    apiKey: "primary-key",
    models: [{ id: "primary-model" }],
  },
  {
    id: "secondary",
    name: "Secondary fixture",
    baseUrl: secondaryUrl,
    apiKey: "secondary-key",
    models: [{ id: "secondary-model" }],
  },
];

let failures = 0;
function check(condition: boolean, label: string) {
  console.log(`${condition ? "  ✅" : "  ❌"} ${label}`);
  if (!condition) failures += 1;
}

try {
  console.log("Provider routing E2E (local OpenAI-compatible fixtures)");
  for (const label of ["primary/primary-model", "secondary/secondary-model"]) {
    const resolved = resolveProviderModel(providers, label);
    await consume(await createProviderRuntime(resolved));
    const request = requests.at(-1);
    check(request?.provider === label.split("/")[0], `${label} selected its provider`);
    check(request?.path === "/v1/chat/completions", `${label} used chat completions endpoint`);
    check(request?.model === label.split("/")[1], `${label} sent its model id`);
  }

  check(
    await Promise.resolve().then(() => resolveProviderModel(providers, "secondary/missing")).catch(() => null) === null,
    "unknown model fails explicitly",
  );
  check(
    await Promise.resolve().then(() =>
      createProviderRuntime({
        ...resolveProviderModel(providers, "primary/primary-model"),
        apiKey: "wrong-key",
      }).then(consume),
    ).then(() => false).catch(() => true),
    "invalid credential fails explicitly",
  );
} finally {
  for (const server of servers) server.stop();
}

console.log(failures === 0 ? "\nPROVIDER ROUTING E2E PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
