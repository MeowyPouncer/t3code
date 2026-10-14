// FORK: composer assist cues in the TipTap composer. The spans the server flagged are decorations
// that follow edits; one whose text no longer reads as the choice it shows is dropped. Choosing
// puts another choice in place and keeps the span, so it can be cycled again or back.
import type { ComposerAssistCueKind } from "@t3tools/contracts";
import { Extension } from "@tiptap/core";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface ComposerAssistCueView {
  readonly id: string;
  readonly kind: ComposerAssistCueKind;
  readonly note: string;
  /** The span's own text first, then the model's alternatives. */
  readonly choices: ReadonlyArray<string>;
  /** The choice the span shows now. */
  readonly index: number;
}

export interface ComposerAssistCueRange {
  readonly from: number;
  readonly to: number;
  readonly cue: ComposerAssistCueView;
}

type CueMeta =
  | { readonly type: "set"; readonly cues: ReadonlyArray<ComposerAssistCueRange> }
  | { readonly type: "put"; readonly range: ComposerAssistCueRange }
  | { readonly type: "remove"; readonly id: string };

export const composerAssistCuesKey = new PluginKey<DecorationSet>("composerAssistCues");

function cueDecoration({ from, to, cue }: ComposerAssistCueRange) {
  return Decoration.inline(
    from,
    to,
    {
      class: `composer-assist-cue composer-assist-cue-${cue.kind}`,
      "data-assist-cue": cue.id,
    },
    { cue, inclusiveStart: false, inclusiveEnd: false },
  );
}

const cueOf = (decoration: Decoration) =>
  (decoration.spec as { readonly cue: ComposerAssistCueView }).cue;

/** An editor view, or anything that holds a state and takes transactions. */
export interface ComposerAssistCueTarget {
  readonly state: EditorState;
  readonly dispatch: (tr: Transaction) => void;
}

export function composerAssistCuesPlugin() {
  return new Plugin<DecorationSet>({
    key: composerAssistCuesKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta(composerAssistCuesKey) as CueMeta | undefined;
        if (meta?.type === "set") {
          return DecorationSet.create(tr.doc, meta.cues.map(cueDecoration));
        }
        let next = set.map(tr.mapping, tr.doc);
        if (tr.docChanged) {
          const stale = next
            .find()
            .filter(
              (decoration) =>
                tr.doc.textBetween(decoration.from, decoration.to, "\n") !==
                cueOf(decoration).choices[cueOf(decoration).index],
            );
          if (stale.length > 0) next = next.remove(stale);
        }
        if (meta?.type === "put" || meta?.type === "remove") {
          const id = meta.type === "put" ? meta.range.cue.id : meta.id;
          next = next.remove(next.find(undefined, undefined, (spec) => spec.cue?.id === id));
          if (meta.type === "put") next = next.add(tr.doc, [cueDecoration(meta.range)]);
        }
        return next;
      },
    },
    props: {
      decorations: (state) => composerAssistCuesKey.getState(state),
    },
  });
}

export const ComposerAssistCuesExtension = Extension.create({
  name: "composerAssistCues",
  addProseMirrorPlugins() {
    return [composerAssistCuesPlugin()];
  },
});

/** The cue the caret or selection sits in, edges included. */
export function composerAssistCueAt(state: EditorState): ComposerAssistCueRange | null {
  const set = composerAssistCuesKey.getState(state);
  if (!set) return null;
  const { from, to } = state.selection;
  const decoration = set
    .find(from, to)
    .find((candidate) => candidate.from <= from && to <= candidate.to);
  return decoration ? { from: decoration.from, to: decoration.to, cue: cueOf(decoration) } : null;
}

export function showComposerAssistCues(
  view: ComposerAssistCueTarget,
  cues: ReadonlyArray<ComposerAssistCueRange>,
): void {
  view.dispatch(view.state.tr.setMeta(composerAssistCuesKey, { type: "set", cues }));
}

/** Puts one of a cue's choices in its place as one undo step; the span stays a cue. */
export function chooseComposerAssistCue(
  view: ComposerAssistCueTarget,
  range: ComposerAssistCueRange,
  index: number,
): boolean {
  const text = range.cue.choices[index];
  if (text === undefined || index === range.cue.index) return false;
  const tr = view.state.tr.insertText(text, range.from, range.to);
  tr.setMeta(composerAssistCuesKey, {
    type: "put",
    range: { from: range.from, to: range.from + text.length, cue: { ...range.cue, index } },
  });
  view.dispatch(tr);
  return true;
}

export function dismissComposerAssistCue(view: ComposerAssistCueTarget, id: string): void {
  view.dispatch(view.state.tr.setMeta(composerAssistCuesKey, { type: "remove", id }));
}

/** The next (+1) or previous (-1) choice of the cue under the caret, wrapping around. */
export function cycleComposerAssistCue(view: ComposerAssistCueTarget, direction: 1 | -1): boolean {
  const range = composerAssistCueAt(view.state);
  if (range === null || range.cue.choices.length < 2) return false;
  const count = range.cue.choices.length;
  return chooseComposerAssistCue(view, range, (range.cue.index + direction + count) % count);
}
