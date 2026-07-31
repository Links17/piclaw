import { describe, expect, test } from "bun:test";
import { createCloudKernelModel } from "./provider.ts";

describe("createCloudKernelModel", () => {
  test("builds an openai-completions model for custom baseUrl", () => {
    const model = createCloudKernelModel({
      baseUrl: "http://192.168.1.190/v1/",
      apiKey: "test-key",
      model: "gpt-5.6-terra",
      contextWindow: 200_000,
    });
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("piclaw-cloud");
    expect(model.id).toBe("gpt-5.6-terra");
    expect(model.baseUrl).toBe("http://192.168.1.190/v1");
    expect(model.contextWindow).toBe(200_000);
  });
});
