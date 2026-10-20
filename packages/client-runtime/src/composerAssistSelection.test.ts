import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { composerAssistModelSelection } from "./composerAssist.ts";

const providers = [
  {
    instanceId: ProviderInstanceId.make("codex-personal"),
    driver: "codex",
    enabled: true,
    models: [{ slug: "gpt-6.1-sol", name: "GPT 6.1 Sol", isDefault: true }],
  },
  {
    instanceId: ProviderInstanceId.make("claude-work"),
    driver: "claudeAgent",
    enabled: true,
    models: [{ slug: "claude-haiku-5-5", name: "Haiku 5.5", aliases: ["haiku"], isDefault: true }],
  },
] as unknown as ReadonlyArray<ServerProvider>;

describe("composer assist model selection", () => {
  it("resolves legacy aliases against the chosen account's catalog", () => {
    expect(
      composerAssistModelSelection({ instanceId: "", model: "", options: [] }, providers),
    ).toEqual({ instanceId: "claude-work", model: "claude-haiku-5-5", options: [] });
  });

  it("keeps an explicit non-Claude instance, model and options", () => {
    const selection = {
      instanceId: "codex-personal",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    expect(composerAssistModelSelection(selection, providers)).toEqual(selection);
  });

  it("keeps an unavailable explicit selection instead of displaying another account", () => {
    const selection = { instanceId: "missing", model: "custom-model", options: [] };
    expect(composerAssistModelSelection(selection, providers)).toEqual(selection);
  });

  it("uses another provider's default only when automatic mode has no Claude", () => {
    expect(
      composerAssistModelSelection(
        { instanceId: "", model: "", options: [] },
        providers.slice(0, 1),
      ),
    ).toEqual({ instanceId: "codex-personal", model: "gpt-6.1-sol", options: [] });
    expect(composerAssistModelSelection({ instanceId: "", model: "", options: [] }, [])).toBeNull();
  });
});
