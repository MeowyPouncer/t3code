// FORK: the user's own rules file reaches every provider's runtime instructions.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";
import {
  buildRuntimeInstructions,
  localInstructions,
  localInstructionsPath,
} from "./RuntimeInstructions.ts";

describe("local instructions", () => {
  let directory: string;
  let file: string;
  const previous = process.env.T3CODE_LOCAL_INSTRUCTIONS_FILE;

  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-local-instructions-"));
    file = NodePath.join(directory, "instructions.md");
    process.env.T3CODE_LOCAL_INSTRUCTIONS_FILE = file;
  });

  afterEach(() => {
    process.env.T3CODE_LOCAL_INSTRUCTIONS_FILE = previous;
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("defaults to ~/.config/t3code/instructions.md and an empty setting turns it off", () => {
    expect(localInstructionsPath({})).toBe(
      NodePath.join(NodeOS.homedir(), ".config", "t3code", "instructions.md"),
    );
    expect(localInstructionsPath({ T3CODE_LOCAL_INSTRUCTIONS_FILE: "" })).toBe("");
    expect(localInstructions("")).toBe("");
  });

  it("adds nothing while the file is missing or blank", () => {
    expect(buildRuntimeInstructions({ harness: "Cursor" })).not.toContain("<local_instructions>");
    NodeFS.writeFileSync(file, "  \n\n");
    expect(buildRuntimeInstructions({ harness: "Cursor" })).not.toContain("<local_instructions>");
  });

  it("appends the trimmed file after the shared runtime context", () => {
    NodeFS.writeFileSync(file, "\nRULE-MARKER: always pass effort options.\n\n");
    const instructions = buildRuntimeInstructions({ harness: "Claude Code" });
    expect(instructions).toMatch(
      /<\/pull_request_linking>\n\n<local_instructions>\nRULE-MARKER: always pass effort options\.\n<\/local_instructions>$/,
    );
    expect(buildRuntimeInstructions({ harness: "Codex", local: false })).not.toContain(
      "RULE-MARKER",
    );
  });

  it("re-reads the file when it changes and cuts a runaway file", () => {
    NodeFS.writeFileSync(file, "first");
    expect(localInstructions()).toContain("first");
    NodeFS.writeFileSync(file, "x".repeat(20_000));
    NodeFS.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const text = localInstructions();
    expect(text).not.toContain("first");
    expect(text.length).toBeLessThan(16_100);
  });

  it("gives Codex the file as its own context entry, not inside the runtime entry", () => {
    NodeFS.writeFileSync(file, "RULE-MARKER");
    const context = buildCodexAdditionalContext({ model: "gpt-5.5", reasoningEffort: "high" });
    expect(context.t3_code_local?.value).toBe(
      "<local_instructions>\nRULE-MARKER\n</local_instructions>",
    );
    expect(context.t3_code_runtime?.value).not.toContain("RULE-MARKER");
    NodeFS.rmSync(file);
    expect(
      buildCodexAdditionalContext({ model: "gpt-5.5", reasoningEffort: "high" }).t3_code_local,
    ).toBeUndefined();
  });
});
