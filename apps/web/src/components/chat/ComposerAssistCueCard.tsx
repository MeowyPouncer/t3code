// FORK: the card over a composer assist cue: what the cue says and what the span can become.
// Its buttons keep focus in the editor, so typing goes on where it was.
import type { ComposerAssistCueView } from "../composerAssistCues";

const KIND_MARK: Record<ComposerAssistCueView["kind"], string> = {
  contradiction: "⚠",
  spelling: "✍",
  sentence: "↻",
  ask: "?",
};

const keepEditorFocus = (event: React.MouseEvent) => event.preventDefault();

export function ComposerAssistCueCard(props: {
  readonly cue: ComposerAssistCueView;
  readonly onChoose: (index: number) => void;
  readonly onDismiss: () => void;
}) {
  const { cue } = props;
  return (
    <div className="flex w-72 max-w-full flex-col gap-1.5 text-xs" data-composer-assist-card="true">
      {cue.note.length > 0 ? (
        <p className="flex gap-1.5 text-foreground">
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            {KIND_MARK[cue.kind]}
          </span>
          <span>{cue.note}</span>
        </p>
      ) : null}
      {cue.choices.length > 1 ? (
        <ul className="flex flex-col">
          {cue.choices.map((choice, index) => (
            // Choices are distinct: the server drops repeats and the span's own text.
            <li key={choice}>
              <button
                type="button"
                className={
                  index === cue.index
                    ? "w-full rounded px-1.5 py-1 text-left bg-accent text-accent-foreground"
                    : "w-full rounded px-1.5 py-1 text-left hover:bg-accent/60"
                }
                aria-current={index === cue.index ? "true" : undefined}
                onMouseDown={keepEditorFocus}
                onClick={() => props.onChoose(index)}
              >
                {index === 0 ? <span className="text-muted-foreground">As written: </span> : null}
                {choice}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <span>{cue.choices.length > 1 ? "Ctrl+Alt+↑/↓ switches" : ""}</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 hover:bg-accent/60"
          onMouseDown={keepEditorFocus}
          onClick={props.onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
