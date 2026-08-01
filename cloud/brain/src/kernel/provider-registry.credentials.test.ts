import { describe, expect, test } from "bun:test";
import {
  resolveProviderModelForUser,
  type ProviderRegistryEntry,
} from "./provider-registry.ts";

const providers: ProviderRegistryEntry[] = [{
  id: "local",
  name: "Local",
  baseUrl: "http://configured.example/v1",
  apiKey: "configured-key",
  models: [{ id: "llama3" }],
}];

describe("provider registry credentials", () => {
  test("uses user keychain values as provider credential overrides", async () => {
    const requested: string[] = [];
    const resolved = await resolveProviderModelForUser(
      providers,
      "local/llama3",
      "user-1",
      async (name, userId) => {
        expect(userId).toBe("user-1");
        requested.push(name);
        return name.endsWith("api_key") ? "user-key" : "https://user.example/v1/";
      },
    );

    expect(requested).toEqual(["provider:local:api_key", "provider:local:base_url"]);
    expect(resolved.apiKey).toBe("user-key");
    expect(resolved.baseUrl).toBe("https://user.example/v1");
  });

  test("keeps configured credentials if optional keychain entries are absent", async () => {
    const resolved = await resolveProviderModelForUser(
      providers,
      "local/llama3",
      "user-1",
      async () => null,
    );

    expect(resolved.apiKey).toBe("configured-key");
    expect(resolved.baseUrl).toBe("http://configured.example/v1");
  });
});
