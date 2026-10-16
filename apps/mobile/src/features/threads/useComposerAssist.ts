// FORK: composer assist on mobile. A blank typed at the end of the draft (" _") asks Claude to
// rewrite or fill it in, with Revert, since the native editor cannot undo text the app set; a
// pause in typing asks for cues, shown in a row above the composer. An answer for a draft that
// has changed since is dropped, never applied.
import { useAtomValue } from "@effect/atom-react";
import {
  composerAssistAnswer,
  type ComposerDraftCue,
  composerBlankOutcome,
  composerBlankTooLong,
  composerDraftCues,
  fromComposerAssistText,
  isTypedComposerBlank,
  relocateComposerCues,
  replaceComposerRange,
  toComposerAssistDraft,
  wantsComposerCues,
} from "@t3tools/client-runtime/composer-assist";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** A cue on the draft, with the text it was made for so "As written" can bring it back. */
export interface MobileComposerCue extends ComposerDraftCue {
  readonly original: string;
}

const NO_CUES: ReadonlyArray<MobileComposerCue> = [];

export type MobileComposerAssistStatus =
  | { readonly kind: "working" }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "rewritten"; readonly before: string; readonly after: string };

export function useComposerAssist(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly instanceId: ProviderInstanceId;
  readonly serverConfig: ServerConfig | null;
  readonly draft: string;
  readonly onChangeDraft: (value: string) => void;
  /** False while the composer answers a question or cannot send. */
  readonly active: boolean;
}) {
  const settings = useAtomValue(
    serverEnvironment.settingsValueAtom(input.environmentId),
  )?.composerAssist;
  const permitted = useAtomValue(
    serverEnvironment.composerAssist.permissionAtom(input.environmentId),
  );
  const supported = input.serverConfig?.environment.capabilities.composerAssist === true;
  const enabled = supported && permitted && input.active && settings !== undefined;
  const wantsCues =
    settings !== undefined &&
    (settings.contradictions ||
      settings.spelling ||
      settings.sentences ||
      settings.askCues ||
      settings.auditor);
  const askAssist = useAtomCommand(serverEnvironment.composerAssist, { reportFailure: false });
  const [status, setStatus] = useState<MobileComposerAssistStatus | null>(null);
  const [cues, setCues] = useState<ReadonlyArray<MobileComposerCue>>([]);
  const previousDraftRef = useRef(input.draft);
  const latestDraftRef = useRef(input.draft);
  const answerCountRef = useRef(0);
  const onChangeDraftRef = useRef(input.onChangeDraft);
  useEffect(() => {
    onChangeDraftRef.current = input.onChangeDraft;
    latestDraftRef.current = input.draft;
  });

  /** Puts `next` in place of the draft if it still reads `expected`. */
  const replaceDraft = useCallback((expected: string, next: string) => {
    if (latestDraftRef.current !== expected) return false;
    latestDraftRef.current = next;
    onChangeDraftRef.current(next);
    return true;
  }, []);

  useEffect(() => {
    const previous = previousDraftRef.current;
    const draft = input.draft;
    previousDraftRef.current = draft;
    if (previous === draft) return;
    setCues((current) => (current.length === 0 ? current : relocateComposerCues(current, draft)));
    setStatus((current) =>
      current?.kind === "note" || (current?.kind === "rewritten" && current.after !== draft)
        ? null
        : current,
    );
    if (!enabled || settings === undefined) return;
    const target = {
      threadId: input.threadId,
      projectId: input.projectId,
      instanceId: input.instanceId,
    };

    if (settings.blanks && isTypedComposerBlank(previous, draft)) {
      const assist = toComposerAssistDraft(draft);
      setCues([]);
      if (composerBlankTooLong(assist)) {
        setStatus({ kind: "note", text: "The draft is too long for a blank." });
        return;
      }
      setStatus({ kind: "working" });
      void askAssist({
        environmentId: input.environmentId,
        input: { operation: "blank", ...target, text: assist.text },
      }).then((result) => {
        setStatus((current) => (current?.kind === "working" ? null : current));
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          const cause = squashAtomCommandFailure(result);
          setStatus({
            kind: "note",
            text: cause instanceof Error ? cause.message : "Claude could not answer the blank.",
          });
          return;
        }
        const answer = composerAssistAnswer(result.value, "blank");
        if (answer === null) return;
        const outcome = composerBlankOutcome(draft, assist, answer.blank);
        if (outcome.kind === "note") setStatus({ kind: "note", text: outcome.text });
        if (outcome.kind !== "replace") return;
        if (replaceDraft(draft, outcome.text)) {
          setStatus({
            kind: "rewritten",
            before: draft.replace(/\s*_\s*$/, ""),
            after: outcome.text,
          });
        } else {
          setStatus({
            kind: "note",
            text: "The draft changed while Claude answered; it was kept.",
          });
        }
      });
      return;
    }

    if (!wantsCues || !wantsComposerCues(draft)) return;
    const timer = setTimeout(() => {
      if (latestDraftRef.current !== draft) return;
      const assist = toComposerAssistDraft(draft);
      void askAssist({
        environmentId: input.environmentId,
        input: { operation: "cues", ...target, text: assist.text },
      }).then((result) => {
        // Cues are optional: a failed check just shows nothing.
        const answer =
          result._tag === "Failure" ? null : composerAssistAnswer(result.value, "cues");
        if (answer === null || latestDraftRef.current !== draft) return;
        answerCountRef.current += 1;
        setCues(
          composerDraftCues(draft, assist, answer.cues.cues, `cue-${answerCountRef.current}`).map(
            (cue) => ({ ...cue, original: cue.quote }),
          ),
        );
        const audit = answer.cues.audit;
        if (audit === undefined) return;
        const text = fromComposerAssistText(audit, assist);
        if (text !== null && replaceDraft(draft, text)) {
          setStatus({ kind: "rewritten", before: draft, after: text });
        }
      });
    }, settings.pauseMs);
    return () => clearTimeout(timer);
  }, [
    askAssist,
    enabled,
    input.draft,
    input.environmentId,
    input.instanceId,
    input.projectId,
    input.threadId,
    replaceDraft,
    settings,
    wantsCues,
  ]);

  /** Puts a choice in place of the cue's text; the cue stays, so it can go back. */
  const choose = useCallback(
    (cue: MobileComposerCue, choice: string) => {
      const draft = latestDraftRef.current;
      if (draft.slice(cue.start, cue.end) !== cue.quote) return;
      const next = replaceComposerRange(draft, cue, choice);
      setCues((current) =>
        current.map((entry) =>
          entry.id === cue.id ? { ...entry, end: cue.start + choice.length, quote: choice } : entry,
        ),
      );
      replaceDraft(draft, next);
    },
    [replaceDraft],
  );

  const dismiss = useCallback((cue: MobileComposerCue) => {
    setCues((current) => current.filter((entry) => entry.id !== cue.id));
  }, []);

  const revert = useCallback(() => {
    if (status?.kind === "rewritten") replaceDraft(status.after, status.before);
    setStatus(null);
  }, [replaceDraft, status]);

  // A draft too short for cues shows none, whatever an earlier answer said.
  const shown = enabled && wantsComposerCues(input.draft) ? cues : NO_CUES;
  return { status, cues: shown, choose, dismiss, revert };
}
