import { beforeEach, describe, expect, mock, test } from "bun:test";

const getSessionForUser = mock(async () => null as Record<string, unknown> | null);
const getAvailableModels = mock(async () => ({
  current: "provider/model-a",
  models: ["provider/model-a"],
  model_options: [],
  thinking_level: "high",
  thinking_level_label: "high",
  supports_thinking: true,
  available_thinking_levels: ["high"],
  available_thinking_level_labels: ["high"],
  provider_usage: null,
  latest_requested_model: "provider/model-a",
  latest_response_model: "provider/model-a",
  scoped_models_only: true,
  enabled_model_patterns: [],
  provider_diagnostics: { providers: [] },
  oobe: { provider_ready_completed_instance: true },
}));

mock.module("@piclaw-cloud/store", () => ({
  getSessionForUser,
}));
mock.module("./models/service.ts", () => ({ getAvailableModels }));

describe("focused ownership routes", () => {
  beforeEach(() => {
    getSessionForUser.mockClear();
    getAvailableModels.mockClear();
  });

  test("models reject a foreign chat session", async () => {
    const { handleModelsRoute } = await import("./models/routes.ts");
    getSessionForUser.mockResolvedValueOnce(null);
    const response = await handleModelsRoute(
      new Request("http://brain.test/agent/models?chat_jid=session-b"),
      new URL("http://brain.test/agent/models?chat_jid=session-b"),
      "user-a",
    );
    expect(response.status).toBe(401);
    expect(getAvailableModels).not.toHaveBeenCalled();
  });

  test("models use authenticated user preferences for owned session", async () => {
    const { handleModelsRoute } = await import("./models/routes.ts");
    getSessionForUser.mockResolvedValueOnce({ id: "session-a", user_id: "user-a" });
    const response = await handleModelsRoute(
      new Request("http://brain.test/agent/models?chat_jid=session-a"),
      new URL("http://brain.test/agent/models?chat_jid=session-a"),
      "user-a",
    );
    expect(response.status).toBe(200);
    expect(getAvailableModels).toHaveBeenCalledWith("session-a", "user-a");
  });
});
