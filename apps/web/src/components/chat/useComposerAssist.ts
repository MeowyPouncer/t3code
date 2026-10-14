// FORK: composer assist in the web composer. A blank typed at the end of the draft (" _") asks
// Claude to rewrite or fill it in; a pause in typing asks for cues, which the editor shows on
// their spans. An answer for a draft that has changed since is dropped, never applied.
import {
  COMPOSER_ASSIST_MIN_CUE_CHARS,
  COMPOSER_ASSIST_PAUSE_MS,
  composerBlankOutcome,
  composerDraftCues,
  fromComposerAssistText,
  isTypedComposerBlank,
  toComposerAssistDraft,
} from "@t3tools/client-runtime/composer-assist";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { collectComposerPromptInlineTokens } from "~/composer-editor-mentions";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useServerConfigs } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditorTiptap";

export type ComposerAssistStatus =
  | { readonly kind: "working" }
  | { readonly kind: "note"; readonly text: string };

const assistDraftOf = (draft: string) =>
  toComposerAssistDraft(draft, collectComposerPromptInlineTokens(draft));

export function useComposerAssist(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly prompt: string;
  readonly promptRef: { readonly current: string };
  /** False while the composer answers a question or cannot send. */
  readonly active: boolean;
  readonly editorRef: { readonly current: ComposerPromptEditorHandle | null };
  /** Replaces the whole draft if it still reads `expected`. */
  readonly replaceDraft: (expected: string, next: string) => boolean;
}): ComposerAssistStatus | null {
  const settings = useEnvironmentSettings(input.environmentId, (all) => all.composerAssist);
  const supported =
    useServerConfigs().get(input.environmentId)?.environment.capabilities?.composerAssist === true;
  const permitted = useEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope);
  const enabled = supported && permitted && input.active;
  const wantsCues =
    settings.contradictions ||
    settings.spelling ||
    settings.sentences ||
    settings.askCues ||
    settings.auditor;
  const askBlank = useAtomCommand(serverEnvironment.composerAssistBlank, { reportFailure: false });
  const askCues = useAtomCommand(serverEnvironment.composerAssistCues, { reportFailure: false });
  const [status, setStatus] = useState<ComposerAssistStatus | null>(null);
  const previousPromptRef = useRef(input.prompt);
  const answerCountRef = useRef(0);
  // The latest values for the async work below, which outlives a render.
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });

  useEffect(() => {
    const previous = previousPromptRef.current;
    const draft = input.prompt;
    previousPromptRef.current = draft;
    if (previous === draft) return;
    // A note answers the draft it was about; the next edit clears it.
    setStatus((current) => (current?.kind === "note" ? null : current));
    if (!enabled) return;
    const target = {
      ...(input.threadId === null ? {} : { threadId: input.threadId }),
      ...(input.projectId === null ? {} : { projectId: input.projectId }),
      ...(input.instanceId === null ? {} : { instanceId: input.instanceId }),
    };

    if (settings.blanks && isTypedComposerBlank(previous, draft)) {
      const assist = assistDraftOf(draft);
      latest.current.editorRef.current?.showAssistCues(draft, []);
      setStatus({ kind: "working" });
      void askBlank({
        environmentId: input.environmentId,
        input: { ...target, text: assist.text },
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
        const outcome = composerBlankOutcome(draft, assist, result.value);
        if (outcome.kind === "note") setStatus({ kind: "note", text: outcome.text });
        if (outcome.kind !== "replace") return;
        if (!latest.current.replaceDraft(draft, outcome.text)) {
          setStatus({
            kind: "note",
            text: "The draft changed while Claude answered; it was kept.",
          });
        }
      });
      return;
    }

    if (!wantsCues) return;
    if (draft.trim().length < COMPOSER_ASSIST_MIN_CUE_CHARS) {
      latest.current.editorRef.current?.showAssistCues(draft, []);
      return;
    }
    const timer = window.setTimeout(() => {
      if (latest.current.promptRef.current !== draft) return;
      const assist = assistDraftOf(draft);
      void askCues({
        environmentId: input.environmentId,
        input: { ...target, text: assist.text },
      }).then((result) => {
        // Cues are optional: a failed check just shows nothing.
        if (result._tag === "Failure" || latest.current.promptRef.current !== draft) return;
        answerCountRef.current += 1;
        latest.current.editorRef.current?.showAssistCues(
          draft,
          composerDraftCues(draft, assist, result.value.cues, `cue-${answerCountRef.current}`),
        );
        const audit = result.value.audit;
        if (audit === undefined) return;
        const text = fromComposerAssistText(audit, assist);
        if (text !== null && latest.current.replaceDraft(draft, text)) {
          setStatus({ kind: "note", text: "The auditor tidied the draft. Undo puts it back." });
        }
      });
    }, COMPOSER_ASSIST_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [
    askBlank,
    askCues,
    enabled,
    input.environmentId,
    input.instanceId,
    input.projectId,
    input.prompt,
    input.threadId,
    settings.blanks,
    wantsCues,
  ]);

  return status;
}
