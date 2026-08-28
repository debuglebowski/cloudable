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
