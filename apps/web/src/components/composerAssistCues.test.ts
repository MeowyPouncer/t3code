import { getSchemaByResolvedExtensions, resolveExtensions } from "@tiptap/core";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  composerAssistCueAt,
  composerAssistCuesKey,
  composerAssistCuesPlugin,
  cycleComposerAssistCue,
  dismissComposerAssistCue,
  showComposerAssistCues,
} from "./composerAssistCues";

const schema = getSchemaByResolvedExtensions(resolveExtensions([StarterKit]));

/** A stand-in for the editor view: a state that takes transactions. */
function editorWith(text: string) {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(text)])]);
  const target = {
    state: EditorState.create({ schema, doc, plugins: [composerAssistCuesPlugin()] }),
    dispatch(tr: Transaction) {
      target.state = target.state.apply(tr);
    },
  };
  return target;
}

const textOf = (target: ReturnType<typeof editorWith>) => target.state.doc.textContent;
const cueCount = (target: ReturnType<typeof editorWith>) =>
  composerAssistCuesKey.getState(target.state)?.find().length ?? 0;
const caretAt = (target: ReturnType<typeof editorWith>, pos: number) =>
  target.dispatch(target.state.tr.setSelection(TextSelection.create(target.state.doc, pos)));

// "Pleese push to main": the paragraph's text starts at position 1.
const spelling = {
  from: 1,
  to: 7,
  cue: { id: "c1", kind: "spelling" as const, note: "", choices: ["Pleese", "Please"], index: 0 },
};

describe("composer assist cues", () => {
  it("cycles a cue's choices in place and back", () => {
    const editor = editorWith("Pleese push to main");
    showComposerAssistCues(editor, [spelling]);
    caretAt(editor, 3);
    expect(composerAssistCueAt(editor.state)?.cue.id).toBe("c1");
    expect(cycleComposerAssistCue(editor, 1)).toBe(true);
    expect(textOf(editor)).toBe("Please push to main");
    caretAt(editor, 3);
    expect(composerAssistCueAt(editor.state)?.cue.index).toBe(1);
    expect(cycleComposerAssistCue(editor, 1)).toBe(true);
    expect(textOf(editor)).toBe("Pleese push to main");
  });

  it("follows edits before a span and drops a span edited inside", () => {
    const editor = editorWith("Pleese push to main");
    showComposerAssistCues(editor, [spelling]);
    editor.dispatch(editor.state.tr.insertText("Hi ", 1));
    expect(cueCount(editor)).toBe(1);
    caretAt(editor, 6);
    expect(composerAssistCueAt(editor.state)?.from).toBe(4);
    editor.dispatch(editor.state.tr.insertText("x", 6));
    expect(cueCount(editor)).toBe(0);
  });

  it("leaves the text alone when a cue is dismissed or has nothing to cycle", () => {
    const editor = editorWith("Deploy on Thursday the 19th");
    showComposerAssistCues(editor, [
      {
        from: 11,
        to: 28,
        cue: {
          id: "c2",
          kind: "contradiction",
          note: "The 19th is a Monday",
          choices: ["Thursday the 19th"],
          index: 0,
        },
      },
    ]);
    caretAt(editor, 12);
    expect(cycleComposerAssistCue(editor, 1)).toBe(false);
    dismissComposerAssistCue(editor, "c2");
    expect(cueCount(editor)).toBe(0);
    expect(textOf(editor)).toBe("Deploy on Thursday the 19th");
  });
});
