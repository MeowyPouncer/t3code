import { describe, expect, it } from "vite-plus/test";

import {
  composerAssistSpanToDraft,
  endsWithComposerBlank,
  fillComposerBlank,
  fromComposerAssistText,
  relocateComposerCues,
  toComposerAssistDraft,
} from "./composerAssist.ts";

describe("composer assist drafts", () => {
  const draft =
    "Fix [a.ts](apps/web/src/a.ts) then run $test-runner on [screenshot.png](t3-context://v1/image/abc) please";

  it("sends chips as markers and brings them back", () => {
    const assist = toComposerAssistDraft(draft);
    expect(assist.text).toBe("Fix ⟦1⟧ then run ⟦2⟧ on ⟦3⟧ please");
    expect(fromComposerAssistText("Please fix ⟦1⟧, then run ⟦2⟧ on ⟦3⟧.", assist)).toBe(
      "Please fix [a.ts](apps/web/src/a.ts), then run $test-runner on [screenshot.png](t3-context://v1/image/abc).",
    );
    expect(fromComposerAssistText("fix ⟦4⟧", assist)).toBeNull();
  });

  it("maps an assist span back onto the draft", () => {
    const assist = toComposerAssistDraft(draft);
    const start = assist.text.indexOf("please");
    const span = composerAssistSpanToDraft(assist, { start, end: start + "please".length });
    expect(draft.slice(span.start, span.end)).toBe("please");
    const run = assist.text.indexOf("then run");
    const runSpan = composerAssistSpanToDraft(assist, { start: run, end: run + 8 });
    expect(draft.slice(runSpan.start, runSpan.end)).toBe("then run");
  });
});

describe("blanks", () => {
  it("fire on a lone trailing underscore outside code", () => {
    expect(endsWithComposerBlank("make this formal _")).toBe(true);
    expect(endsWithComposerBlank("_")).toBe(true);
    expect(endsWithComposerBlank("list:\n_")).toBe(true);
    expect(endsWithComposerBlank("rename to snake_case_")).toBe(false);
    expect(endsWithComposerBlank("call __init__")).toBe(false);
    expect(endsWithComposerBlank("run `ls _")).toBe(false);
    expect(endsWithComposerBlank("```\nx = _")).toBe(false);
    expect(endsWithComposerBlank("```\ncode\n```\nexplain _")).toBe(true);
  });

  it("fill only the trailing underscore", () => {
    expect(fillComposerBlank("test command _", "pnpm test")).toBe("test command pnpm test");
  });
});

describe("relocateComposerCues", () => {
  it("keeps, moves or drops cues after an edit", () => {
    const cues = [
      { start: 0, end: 6, quote: "Pleese", id: "a" },
      { start: 15, end: 19, quote: "main", id: "b" },
      { start: 20, end: 25, quote: "gone!", id: "c" },
    ];
    const next = "Pleese, now push to main";
    expect(relocateComposerCues(cues, next)).toEqual([
      { start: 0, end: 6, quote: "Pleese", id: "a" },
      { start: 20, end: 24, quote: "main", id: "b" },
    ]);
  });
});
