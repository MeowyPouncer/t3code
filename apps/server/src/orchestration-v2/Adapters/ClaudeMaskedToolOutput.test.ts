// FORK: what the model saw masked stays masked in T3's native protocol log.
import { describe, expect, it } from "vite-plus/test";

import { claudeToolResultWasMasked, withoutRawMaskedToolResult } from "./ClaudeAdapterV2.ts";

describe("masked Claude tool output", () => {
  const masked = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "KEY=[masked: env-secret]" }],
    },
    tool_use_result: { stdout: "KEY=raw-value", stderr: "" },
  };

  it("recognises the mask marker in a string or in content blocks", () => {
    expect(claudeToolResultWasMasked("a [masked: github-token] b")).toBe(true);
    expect(claudeToolResultWasMasked([{ type: "text", text: "[masked: jwt]" }])).toBe(true);
    expect(claudeToolResultWasMasked("plain output")).toBe(false);
    expect(claudeToolResultWasMasked(undefined)).toBe(false);
  });

  it("drops the raw tool_use_result only when the model's copy was masked", () => {
    expect(JSON.stringify(withoutRawMaskedToolResult(masked))).not.toContain("raw-value");
    expect(withoutRawMaskedToolResult(masked)).toMatchObject({
      type: "user",
      message: masked.message,
    });
    const plain = { ...masked, message: { role: "user", content: "fine" } };
    expect(withoutRawMaskedToolResult(plain)).toBe(plain);
    const assistant = { type: "assistant", message: { content: "[masked: x]" } };
    expect(withoutRawMaskedToolResult(assistant)).toBe(assistant);
    expect(withoutRawMaskedToolResult("text")).toBe("text");
  });
});
