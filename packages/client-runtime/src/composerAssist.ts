// FORK: composer assist on the client (web and mobile): the draft goes to the server with every chip
// replaced by a ⟦n⟧ marker, and what comes back is put into the draft without losing a chip.
import {
  COMPOSER_ASSIST_MAX_DRAFT_CHARS,
  type ComposerAssistBlankResult,
  type ComposerAssistCue,
} from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

/** A pause this long after the last keystroke asks for cues. */
export const COMPOSER_ASSIST_PAUSE_MS = 1_500;
/** Drafts shorter than this get no cues: there is nothing worth saying yet. */
export const COMPOSER_ASSIST_MIN_CUE_CHARS = 12;
/** Longer drafts get no cues (mostly pasted logs or code); the server refuses them too. */
export const COMPOSER_ASSIST_MAX_CUE_CHARS = 12_000;

/** The languages a blank can rewrite into, for the settings; "" keeps the draft's language. */
export const COMPOSER_ASSIST_LANGUAGES = [
  { value: "", label: "Same as the draft" },
  { value: "English", label: "English" },
  { value: "Russian", label: "Russian" },
] as const;

/** Whether a draft is worth a cue check at all. */
export function wantsComposerCues(draft: string): boolean {
  return (
    draft.trim().length >= COMPOSER_ASSIST_MIN_CUE_CHARS &&
    draft.length <= COMPOSER_ASSIST_MAX_CUE_CHARS
  );
}

export interface ComposerAssistDraft {
  /** The draft as sent to the server, chips as ⟦1⟧, ⟦2⟧, … in order. */
  readonly text: string;
  /** Each chip's source text in the draft; `chips[0]` is ⟦1⟧. */
  readonly chips: ReadonlyArray<string>;
  /** Where each chip starts in the draft and in `text`. */
  readonly anchors: ReadonlyArray<{ readonly draft: number; readonly assist: number }>;
}

export interface ComposerTextRange {
  readonly start: number;
  readonly end: number;
}

/** The chips a draft string shows: mentions, skills, file links, citations and context references. */
export function composerDraftChipRanges(draft: string): ReadonlyArray<ComposerTextRange> {
  const ranges: ComposerTextRange[] = [];
  // Links first: an unfinished @ mention can otherwise claim the start of a link label.
  for (const link of [
    ...collectAssistantCitations(draft),
    ...collectComposerContextReferences(draft),
  ]) {
    ranges.push({ start: link.start, end: link.end });
  }
  for (const token of collectComposerInlineTokens(draft)) {
    if (ranges.some((range) => token.start < range.end && range.start < token.end)) continue;
    ranges.push({ start: token.start, end: token.end });
  }
  return ranges;
}

export function toComposerAssistDraft(
  draft: string,
  chipRanges: ReadonlyArray<ComposerTextRange> = composerDraftChipRanges(draft),
): ComposerAssistDraft {
  const ordered = chipRanges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const chips: string[] = [];
  const anchors: Array<{ draft: number; assist: number }> = [];
  let text = "";
  let cursor = 0;
  for (const range of ordered) {
    if (range.start < cursor) continue;
    text += draft.slice(cursor, range.start);
    anchors.push({ draft: range.start, assist: text.length });
    chips.push(draft.slice(range.start, range.end));
    text += `⟦${chips.length}⟧`;
    cursor = range.end;
  }
  text += draft.slice(cursor);
  return { text, chips, anchors };
}

/** Assist text back to a draft; null when it names a chip the draft never had. */
export function fromComposerAssistText(text: string, draft: ComposerAssistDraft): string | null {
  let unknown = false;
  const restored = text.replace(/⟦(\d+)⟧/g, (marker, index: string) => {
    const chip = draft.chips[Number(index) - 1];
    if (chip === undefined) unknown = true;
    return chip ?? marker;
  });
  return unknown ? null : restored;
}

/** A span of the assist text as a span of the draft. Cues never cover a marker. */
export function composerAssistSpanToDraft(
  draft: ComposerAssistDraft,
  span: ComposerTextRange,
): ComposerTextRange {
  const shift = (offset: number) => {
    let delta = 0;
    draft.anchors.forEach((anchor, index) => {
      const markerLength = `⟦${index + 1}⟧`.length;
      if (anchor.assist + markerLength <= offset) {
        delta += (draft.chips[index]?.length ?? markerLength) - markerLength;
      }
    });
    return offset + delta;
  };
  return { start: shift(span.start), end: shift(span.end) };
}

/** Whether a fenced block or inline code is still open at the end of `text`. */
function endsInCode(text: string): boolean {
  if ((text.match(/```/g)?.length ?? 0) % 2 === 1) return true;
  const lastLine = text.slice(text.lastIndexOf("\n") + 1).replace(/```/g, "");
  return (lastLine.match(/`/g)?.length ?? 0) % 2 === 1;
}

/**
 * A blank: the draft ends with "_" standing alone (after whitespace or at the start), outside code.
 * `snake_case_` and `__init__` never fire.
 */
export function endsWithComposerBlank(draft: string): boolean {
  if (!/(?:^|\s)_$/.test(draft)) return false;
  return !endsInCode(draft.slice(0, -1));
}

/** The draft with its trailing blank replaced by a filled-in value. */
export function fillComposerBlank(draft: string, value: string): string {
  return `${draft.slice(0, -1)}${value}`;
}

export interface ComposerCueSpan extends ComposerTextRange {
  /** The text the cue was made for; a cue whose text is gone is dropped. */
  readonly quote: string;
}

/**
 * Cues kept across an edit: one whose quote is still at its place stays, one whose quote moved is
 * found again nearest its old place, and one whose quote is gone is dropped.
 */
export function relocateComposerCues<T extends ComposerCueSpan>(
  cues: ReadonlyArray<T>,
  nextDraft: string,
): ReadonlyArray<T> {
  const kept: T[] = [];
  for (const cue of cues) {
    if (nextDraft.slice(cue.start, cue.end) === cue.quote) {
      kept.push(cue);
      continue;
    }
    let best = -1;
    for (
      let at = nextDraft.indexOf(cue.quote);
      at !== -1;
      at = nextDraft.indexOf(cue.quote, at + 1)
    ) {
      if (best === -1 || Math.abs(at - cue.start) < Math.abs(best - cue.start)) best = at;
    }
    if (best === -1) continue;
    kept.push({ ...cue, start: best, end: best + cue.quote.length });
  }
  return kept.filter(
    (cue, index) =>
      !kept.some(
        (other, otherIndex) => otherIndex < index && other.start < cue.end && cue.start < other.end,
      ),
  );
}

export function replaceComposerRange(
  draft: string,
  range: ComposerTextRange,
  text: string,
): string {
  return `${draft.slice(0, range.start)}${text}${draft.slice(range.end)}`;
}

/** The edit from `previous` to `next` was typing a blank at the end of the draft. */
export function isTypedComposerBlank(previous: string, next: string): boolean {
  const kept = previous.trimEnd();
  return (
    next.length > previous.length &&
    next.startsWith(kept) &&
    next.slice(kept.length).trim() === "_" &&
    endsWithComposerBlank(next)
  );
}

export type ComposerBlankOutcome =
  | { readonly kind: "replace"; readonly text: string }
  | { readonly kind: "note"; readonly text: string };

export function composerBlankTooLong(assist: ComposerAssistDraft): boolean {
  return assist.text.length > COMPOSER_ASSIST_MAX_DRAFT_CHARS;
}

/** What a blank's answer does to the draft it was asked for. A blank never ends silently. */
export function composerBlankOutcome(
  draft: string,
  assist: ComposerAssistDraft,
  result: ComposerAssistBlankResult,
): ComposerBlankOutcome {
  if (result._tag === "none") {
    // Older servers answered some blanks with no reason.
    return { kind: "note", text: result.reason ?? "Claude left the draft as it is." };
  }
  const text = fromComposerAssistText(result.text, assist);
  if (text === null) {
    return { kind: "note", text: "The answer named a file or skill the draft does not have." };
  }
  return {
    kind: "replace",
    text: result._tag === "rewrite" ? text : fillComposerBlank(draft.trimEnd(), text),
  };
}

export interface ComposerDraftCue extends ComposerCueSpan {
  readonly id: string;
  readonly kind: ComposerAssistCue["kind"];
  readonly note: string;
  readonly alternatives: ReadonlyArray<string>;
}

/** The server's cues as spans of the draft, ready to show; `key` keeps ids unique per answer. */
export function composerDraftCues(
  draft: string,
  assist: ComposerAssistDraft,
  cues: ReadonlyArray<ComposerAssistCue>,
  key: string,
): ReadonlyArray<ComposerDraftCue> {
  return cues.flatMap((cue, index) => {
    const span = composerAssistSpanToDraft(assist, cue);
    const quote = draft.slice(span.start, span.end);
    if (quote.length === 0) return [];
    return [
      {
        id: `${key}:${index}`,
        kind: cue.kind,
        start: span.start,
        end: span.end,
        quote,
        note: cue.note,
        alternatives: cue.alternatives,
      },
    ];
  });
}
