import { assert, describe, it } from "@effect/vitest";

import { parseBlankReply, parseCuesReply, parseListReply } from "./composerAssistParse.ts";
import { renderCalendar } from "./composerAssistPrompts.ts";

describe("parseBlankReply", () => {
  const draft = "fix the crash in ⟦1⟧ when the list is empty make it a numbered list _";

  it("takes a rewrite that keeps every file and skill marker", () => {
    const outcome = parseBlankReply(
      "<verdict>REWRITE</verdict>\n<text>\n1. Fix the crash in ⟦1⟧.\n2. Cover the empty list.\n</text>",
      draft,
    );
    assert.deepStrictEqual(outcome, {
      kind: "rewrite",
      text: "1. Fix the crash in ⟦1⟧.\n2. Cover the empty list.",
    });
  });

  it("refuses a rewrite that lost a marker", () => {
    const outcome = parseBlankReply("<verdict>REWRITE</verdict><text>Fix the crash.</text>", draft);
    assert.strictEqual(outcome.kind, "none");
    assert.isDefined(outcome.kind === "none" ? outcome.reason : undefined);
  });

  it("fills only a plain value", () => {
    assert.deepStrictEqual(
      parseBlankReply("<verdict>FILL</verdict><text> pnpm vitest run </text>", "test command _"),
      { kind: "fill", text: "pnpm vitest run" },
    );
    assert.strictEqual(
      parseBlankReply("<verdict>FILL</verdict><text>see ⟦2⟧</text>", "which file _").kind,
      "none",
    );
  });

  it("gives a reason whenever the blank changes nothing", () => {
    for (const reply of [
      "<verdict>NONE</verdict><text></text>",
      "<verdict>REWRITE</verdict><text>\n</text>",
      "<verdict>FILL</verdict><text></text>",
      "Sure! Here you go.",
    ]) {
      const outcome = parseBlankReply(reply, "a _");
      assert.strictEqual(outcome.kind, "none");
      assert.isAbove(outcome.kind === "none" ? outcome.reason.length : 0, 0);
    }
  });
});

describe("parseCuesReply", () => {
  const all = ["contradiction", "spelling", "sentence", "ask"] as const;

  it("places quotes by offset and keeps what can be shown", () => {
    const text = "Pleese push to origin/main. Then clean things up a bit.";
    const reply = JSON.stringify({
      cues: [
        { kind: "spelling", quote: "Pleese", note: "", alternatives: ["Please"] },
        {
          kind: "contradiction",
          quote: "push to origin/main",
          note: "Push only to origin/mp/main",
          alternatives: ["push to origin/mp/main"],
        },
        {
          kind: "ask",
          quote: "Then clean things up a bit.",
          note: "Which things?",
          alternatives: ["Then remove the unused imports.", "Then delete the temp files."],
        },
      ],
    });
    const parsed = parseCuesReply(reply, text, all, false);
    assert.deepStrictEqual(
      parsed.cues.map((cue) => [cue.kind, text.slice(cue.start, cue.end)]),
      [
        ["spelling", "Pleese"],
        ["contradiction", "push to origin/main"],
        ["ask", "Then clean things up a bit."],
      ],
    );
  });

  it("drops quotes it cannot find, code, markers, disabled kinds and thin cues", () => {
    const text = "Run `pnpm tset` on ⟦1⟧ and make it better.";
    const reply = `\`\`\`json\n${JSON.stringify({
      cues: [
        { kind: "spelling", quote: "tset", note: "", alternatives: ["test"] },
        { kind: "spelling", quote: "⟦1⟧", note: "", alternatives: ["file"] },
        { kind: "spelling", quote: "nowhere", note: "", alternatives: ["x"] },
        { kind: "ask", quote: "make it better", note: "Better how?", alternatives: ["faster"] },
        { kind: "sentence", quote: "make it better", note: "Clearer", alternatives: ["x"] },
      ],
    })}\n\`\`\``;
    const parsed = parseCuesReply(reply, text, ["spelling", "ask"], false);
    assert.deepStrictEqual(parsed.cues, []);
  });

  it("keeps the more important cue where two overlap", () => {
    const text = "Deploy on Thursday the 19th.";
    const reply = JSON.stringify({
      cues: [
        {
          kind: "sentence",
          quote: "Deploy on Thursday the 19th.",
          note: "Shorter",
          alternatives: ["Deploy Thu 19th."],
        },
        {
          kind: "contradiction",
          quote: "Thursday the 19th",
          note: "The 19th is a Monday",
          alternatives: [],
        },
      ],
    });
    const parsed = parseCuesReply(reply, text, all, false);
    assert.deepStrictEqual(
      parsed.cues.map((cue) => cue.kind),
      ["contradiction"],
    );
  });

  it("accepts an audit only when it keeps the markers and changes something", () => {
    const text = "fix teh bug in ⟦1⟧";
    assert.strictEqual(
      parseCuesReply(JSON.stringify({ cues: [], audit: "Fix the bug in ⟦1⟧." }), text, all, true)
        .audit,
      "Fix the bug in ⟦1⟧.",
    );
    assert.strictEqual(
      parseCuesReply(JSON.stringify({ cues: [], audit: "Fix the bug." }), text, all, true).audit,
      null,
    );
    assert.strictEqual(
      parseCuesReply(JSON.stringify({ cues: [], audit: "Fix the bug in ⟦1⟧." }), text, all, false)
        .audit,
      null,
    );
  });
});

describe("parseListReply", () => {
  it("dedupes, trims and caps", () => {
    const reply = `{"rules":["  Push only to mp/main ", "Push only to mp/main", "", 3, "Ask before release"]}`;
    assert.deepStrictEqual(parseListReply(reply, "rules", 24), [
      "Push only to mp/main",
      "Ask before release",
    ]);
    assert.deepStrictEqual(parseListReply(reply, "rules", 1), ["Push only to mp/main"]);
    assert.deepStrictEqual(parseListReply("no json", "rules", 24), []);
  });
});

describe("renderCalendar", () => {
  it("names weekdays so a model need not compute them", () => {
    const calendar = renderCalendar({ year: 2026, month: 10, day: 14 });
    assert.include(calendar, "2026-10-14 Wed (today)");
    assert.include(calendar, "2026-10-19 Mon");
    assert.include(calendar, "2026-11-01 Sun");
    assert.include(renderCalendar({ year: 2028, month: 3, day: 1 }), "2028-02-29 Tue");
  });
});
