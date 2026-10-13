// FORK: asks why a thread goes on the shelf.
import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

/** The server's limit on a shelf note. */
const SHELF_NOTE_MAX_LENGTH = 500;

type ShelfNoteChoice = { readonly note: string | null };
type ShelfNoteRequest = {
  /** "shelve" moves the thread to the shelf; "edit" changes the note of a shelved one. */
  readonly mode: "shelve" | "edit";
  readonly threadTitle: string;
  readonly note: string | null;
};
type Request = ShelfNoteRequest & {
  readonly resolve: (choice: ShelfNoteChoice | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Resolves with the note to send (null for none), or null when the user cancels. */
export function requestShelfNote(input: ShelfNoteRequest): Promise<ShelfNoteChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...input, resolve } }));
}

function finish(choice: ShelfNoteChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function ShelfNoteDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <ShelfNoteDialog request={request} /> : null;
}

function ShelfNoteDialog({ request }: { readonly request: Request }) {
  const id = useId();
  const [note, setNote] = useState(request.note ?? "");
  const submit = () => {
    const trimmed = note.trim();
    finish({ note: trimmed === "" ? null : trimmed });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {request.mode === "shelve" ? "Move to shelf" : "Edit shelf note"}
            </DialogTitle>
            <DialogDescription>
              {request.mode === "shelve"
                ? `“${request.threadTitle}” leaves your inbox until you write in it or an agent wakes it.`
                : `Why “${request.threadTitle}” is on the shelf.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-note`}>Note (optional)</Label>
              <Textarea
                id={`${id}-note`}
                autoFocus
                maxLength={SHELF_NOTE_MAX_LENGTH}
                placeholder="What is worth coming back to"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">{request.mode === "shelve" ? "Move to shelf" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
