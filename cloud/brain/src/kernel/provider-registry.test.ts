import { describe, expect, test } from "bun:test";
import {
  buildProviderRegistryEntries,
  parseProviderModelLabel,
  resolveProviderModel,
  type ProviderRegistryEntry,
} from "./provider-registry.ts";

const providers: ProviderRegistryEntry[] = [
  {
    id: "piclaw-cloud",
    name: "PiClaw Cloud",
    baseUrl: "https://api.example.test/v1",
    apiKey: "default-key",
    models: [
      {
        id: "gpt-default",
        contextWindow: 128_000,
        maxTokens: 8192,
      },
    ],
  },
  {
    id: "local",
    name: "Local OpenAI Compatible",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "local-key",
    models: [
      {
        id: "llama3",
        contextWindow: 32_000,
        maxTokens: 4096,
      },
    ],
  },
];

describe("provider registry", () => {
  test("builds the legacy default followed by configured providers", () => {
    const entries = buildProviderRegistryEntries({
      openai: {
        baseUrl: "https://default.example/v1",
        apiKey: "default-key",
        model: "gpt-default",
      },
      providers: [{
        id: "local",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local-key",
        models: [{ id: "llama3", contextWindow: 32_000 }],
      }],
    });

    expect(entries.map((entry) => entry.id)).toEqual(["piclaw-cloud", "local"]);
    expect(entries[1]?.models[0]?.id).toBe("llama3");
  });

  test("parses provider/model labels and rejects malformed labels", () => {
    expect(parseProviderModelLabel("local/llama3")).toEqual({
      provider: "local",
      model: "llama3",
    });
    expect(parseProviderModelLabel("gpt-default")).toBeNull();
    expect(parseProviderModelLabel(" /llama3 ")).toBeNull();
  });

  test("resolves the configured default provider and model", () => {
    expect(resolveProviderModel(providers, null)).toMatchObject({
      providerId: "piclaw-cloud",
      modelId: "gpt-default",
      baseUrl: "https://api.example.test/v1",
      apiKey: "default-key",
    });
  });

  test("resolves an explicitly selected provider and model", () => {
    expect(resolveProviderModel(providers, "local/llama3")).toMatchObject({
      providerId: "local",
      modelId: "llama3",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local-key",
      contextWindow: 32_000,
    });
  });

  test("fails explicitly for unknown providers, models, and missing credentials", () => {
    expect(() => resolveProviderModel(providers, "missing/model")).toThrow(/unknown provider/i);
    expect(() => resolveProviderModel(providers, "local/missing")).toThrow(/unknown model/i);
    expect(() => resolveProviderModel([
      { ...providers[1]!, apiKey: "" },
    ], "local/llama3")).toThrow(/credentials/i);
  });
});
