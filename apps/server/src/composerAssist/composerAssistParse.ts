// FORK: turns Claude's replies for composer assist into checked results. The model quotes the draft
// instead of counting characters; offsets are found here, and anything that cannot be placed safely
// is dropped rather than shown wrong.
import type { ComposerAssistCueKindName } from "./composerAssistPrompts.ts";

export type ComposerAssistBlankOutcome =
  | { readonly kind: "rewrite"; readonly text: string }
  | { readonly kind: "fill"; readonly text: string }
  | { readonly kind: "none"; readonly reason?: string };

export interface ComposerAssistCueDraft {
  readonly kind: ComposerAssistCueKindName;
  readonly start: number;
  readonly end: number;
  readonly note: string;
  readonly alternatives: ReadonlyArray<string>;
}

const MARKER = /⟦\d+⟧/g;
const KIND_LIMITS: Record<ComposerAssistCueKindName, number> = {
  contradiction: 3,
  ask: 2,
  sentence: 2,
  spelling: 5,
};
/** Overlapping cues keep the one that matters most. */
const KIND_PRIORITY: ReadonlyArray<ComposerAssistCueKindName> = [
  "contradiction",
  "ask",
  "sentence",
  "spelling",
];
const MIN_ALTERNATIVES: Record<ComposerAssistCueKindName, number> = {
  contradiction: 0,
  ask: 2,
  sentence: 1,
  spelling: 1,
};
const MAX_NOTE_CHARS = 120;

export function composerMarkers(text: string): ReadonlyArray<string> {
  return (text.match(MARKER) ?? []).toSorted();
}

function sameMarkers(left: string, right: string): boolean {
  const a = composerMarkers(left);
  const b = composerMarkers(right);
  return a.length === b.length && a.every((marker, index) => marker === b[index]);
}

function tagContent(reply: string, tag: string): string | null {
  const open = reply.indexOf(`<${tag}>`);
  const close = reply.lastIndexOf(`</${tag}>`);
  if (open === -1 || close === -1 || close < open) return null;
  return reply.slice(open + tag.length + 2, close);
}

/** One newline right inside a tag is layout, not content. */
function unwrapLines(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

/**
 * `draft` ends with the blank's "_". A rewrite must keep every file and skill marker; a fill
 * replaces only the "_" and so may not bring markers of its own.
 */
export function parseBlankReply(reply: string, draft: string): ComposerAssistBlankOutcome {
  const verdict = tagContent(reply, "verdict")?.trim().toUpperCase();
  const text = unwrapLines(tagContent(reply, "text") ?? "");
  if (verdict === "REWRITE") {
    if (text.trim().length === 0) return { kind: "none" };
    const withoutBlank = draft.replace(/\s*_\s*$/, "");
    if (!sameMarkers(text, withoutBlank)) {
      return { kind: "none", reason: "The rewrite lost a file or skill reference." };
    }
    return { kind: "rewrite", text };
  }
  if (verdict === "FILL") {
    const value = text.trim();
    if (value.length === 0) return { kind: "none" };
    if (composerMarkers(value).length > 0) return { kind: "none" };
    return { kind: "fill", text: value };
  }
  return { kind: "none" };
}

/** The first JSON object in a reply, tolerating fences or a stray sentence around it. */
export function parseJsonObject(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(reply.slice(start, end + 1));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseListReply(reply: string, key: string, max: number): ReadonlyArray<string> {
  const value = parseJsonObject(reply)?.[key];
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const line = item.replace(/\s+/g, " ").trim().slice(0, 200);
    if (line.length === 0 || seen.has(line)) continue;
    seen.add(line);
    items.push(line);
    if (items.length === max) break;
  }
  return items;
}

/** Fenced blocks and inline code: never quoted, never rewritten by a cue. */
function codeRanges(text: string): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(/```[\s\S]*?(?:```|$)/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(/`[^`\n]+`/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

const overlaps = (a: readonly [number, number], b: readonly [number, number]) =>
  a[0] < b[1] && b[0] < a[1];

function cleanAlternatives(value: unknown, quote: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>([quote]);
  const alternatives: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const alternative = item.trim();
    if (alternative.length === 0 || seen.has(alternative)) continue;
    if (composerMarkers(alternative).length > 0) continue;
    seen.add(alternative);
    alternatives.push(alternative);
    if (alternatives.length === 4) break;
  }
  return alternatives;
}

export interface ParsedCues {
  readonly cues: ReadonlyArray<ComposerAssistCueDraft>;
  readonly audit: string | null;
}

export function parseCuesReply(
  reply: string,
  text: string,
  kinds: ReadonlyArray<ComposerAssistCueKindName>,
  audit: boolean,
): ParsedCues {
  const object = parseJsonObject(reply);
  if (object === null) return { cues: [], audit: null };
  const blocked = [...codeRanges(text)];
  for (const match of text.matchAll(MARKER)) {
    blocked.push([match.index, match.index + match[0].length]);
  }
  const candidates: ComposerAssistCueDraft[] = [];
  const rawCues = Array.isArray(object.cues) ? object.cues : [];
  for (const raw of rawCues) {
    if (typeof raw !== "object" || raw === null) continue;
    const cue = raw as Record<string, unknown>;
    const kind = cue.kind as ComposerAssistCueKindName;
    if (!kinds.includes(kind)) continue;
    const quote = typeof cue.quote === "string" ? cue.quote.trim() : "";
    if (quote.length === 0) continue;
    const alternatives = cleanAlternatives(cue.alternatives, quote);
    if (alternatives.length < MIN_ALTERNATIVES[kind]) continue;
    const note = typeof cue.note === "string" ? cue.note.trim().slice(0, MAX_NOTE_CHARS) : "";
    if (kind !== "spelling" && note.length === 0) continue;
    let from = 0;
    while (from <= text.length) {
      const start = text.indexOf(quote, from);
      if (start === -1) break;
      const span = [start, start + quote.length] as const;
      const taken = candidates.some((other) => other.start === start && other.kind === kind);
      if (!taken && !blocked.some((range) => overlaps(range, span))) {
        candidates.push({ kind, start: span[0], end: span[1], note, alternatives });
        break;
      }
      from = start + 1;
    }
  }
  const kept: ComposerAssistCueDraft[] = [];
  for (const kind of KIND_PRIORITY) {
    let count = 0;
    for (const cue of candidates.filter((candidate) => candidate.kind === kind)) {
      if (count === KIND_LIMITS[kind]) break;
      if (kept.some((other) => overlaps([other.start, other.end], [cue.start, cue.end]))) continue;
      kept.push(cue);
      count += 1;
    }
  }
  const auditText = audit && typeof object.audit === "string" ? object.audit : null;
  const usableAudit =
    auditText !== null &&
    auditText.trim().length > 0 &&
    auditText !== text &&
    sameMarkers(auditText, text)
      ? auditText
      : null;
  return { cues: kept.toSorted((a, b) => a.start - b.start), audit: usableAudit };
}
