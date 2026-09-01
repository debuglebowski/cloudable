import { Check, Pencil, X } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface EditableCellProps {
  value: string;
  onSave: (next: string) => void;
}

/**
 * Inline-editable text cell for `source: "manual"` People rows only — SCIM-synced rows render
 * plain text instead (see people-page.tsx).
 */
export function EditableCell({ value, onSave }: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // Enter commits, which unmounts the focused <Input> and triggers a native blur — that blur is
  // wired to the same commit(), so this guards against firing onSave twice for one edit.
  const committedRef = useRef(false);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          committedRef.current = false;
          setDraft(value);
          setEditing(true);
        }}
        className="group -mx-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent"
      >
        <span>{value}</span>
        <Pencil className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
      </button>
    );
  }

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    }
  };

  // Also marks committedRef so the blur that unmounting triggers doesn't re-run commit() and
  // save the abandoned draft.
  const cancel = () => {
    committedRef.current = true;
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        // A focused text input's cursor lands at the end of its value by
        // default, and the browser auto-scrolls to keep it visible — for a
        // value longer than this narrow cell (most emails), that hides the
        // *start* of the value the instant editing begins. Verified live via
        // computed state (`scrollLeft`/`selectionStart`), not just a
        // screenshot: clicking "marcus.webb@acme.com" left `scrollLeft: 13`,
        // `selectionStart/End: 20/20` — cursor and scroll both parked at the
        // end, hiding the leading "m". `select()` alone doesn't fix the
        // scroll (confirmed live: selection moved to 0/20 but `scrollLeft`
        // stayed put) since the browser tracks the *active* edge of a
        // selection, which a forward select-all leaves at the end — so
        // `scrollLeft` is reset explicitly too, deferred a frame since
        // setting it in the same tick as focus/select doesn't hold (the
        // browser's own "scroll the caret into view" pass for this same
        // focus event runs after and undoes a same-tick write).
        //
        // Full end-to-end confirmation (an actual focus event firing) wasn't
        // possible in this session's automated browser — that harness runs
        // without real OS-level window focus, so `document.activeElement`
        // updates correctly but no `focus` event ever dispatches at all, for
        // *any* input on the page, React-wired or a raw `addEventListener`
        // alike (checked directly). The scroll-position mechanics above were
        // each verified in isolation by driving them manually against the
        // already-focused element; only the "does a real focus event trigger
        // this handler" link in the chain rests on `select()`-on-focus being
        // the well-established standard fix for this exact failure mode.
        onFocus={(event) => {
          const input = event.target;
          input.select();
          requestAnimationFrame(() => {
            input.scrollLeft = 0;
          });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") cancel();
        }}
        onBlur={commit}
        className="h-7 w-auto min-w-40"
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        // onMouseDown (not onClick) so this fires before the input's onBlur cancels editing.
        onMouseDown={(event) => {
          event.preventDefault();
          commit();
        }}
      >
        <Check className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        onMouseDown={(event) => {
          event.preventDefault();
          cancel();
        }}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
