import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ComposerAssistSettings, ServerSettingsPatch } from "./settings.ts";

const decode = Schema.decodeUnknownSync(ComposerAssistSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("composer assist provider selection", () => {
  it("accepts configured model IDs and provider options in saved settings and patches", () => {
    const selection = {
      instanceId: "codex-personal",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const settings = decode(selection);
    expect(settings).toMatchObject(selection);
    expect(decodePatch({ composerAssist: selection })).toMatchObject({ composerAssist: selection });
  });

  it("keeps the legacy Claude default and aliases readable", () => {
    expect(decode({})).toMatchObject({ instanceId: "", model: "", options: [] });
    for (const model of ["", "haiku", "sonnet", "opus"]) {
      expect(decode({ model }).model).toBe(model);
    }
  });
});
