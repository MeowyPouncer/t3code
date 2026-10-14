// FORK: composer assist's line above the composer: a blank being answered, or a short note on
// what happened to it.
import { Spinner } from "~/components/ui/spinner";

import { ComposerBanner } from "./ComposerBanner";
import type { ComposerAssistStatus } from "./useComposerAssist";

export function ComposerAssistStatusRow({ status }: { readonly status: ComposerAssistStatus }) {
  return (
    <ComposerBanner.Row>
      {status.kind === "working" ? (
        <ComposerBanner.Icon>
          <Spinner />
        </ComposerBanner.Icon>
      ) : null}
      <ComposerBanner.Content>
        <span className="min-w-0 text-muted-foreground" role="status">
          {status.kind === "working" ? "Claude is answering the blank…" : status.text}
        </span>
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
}
