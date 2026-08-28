import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ValueEditDialogProps<T> {
  open: boolean;
  currentValue: T;
  title: ReactNode;
  description: ReactNode;
  onOpenChange: (open: boolean) => void;
  onSave: (value: T) => void | Promise<void>;
  isValid?: (value: T) => boolean;
  children: (value: T, setValue: (next: T) => void) => ReactNode;
}

/**
 * Shared open/reset/save lifecycle for a single-value settings dialog: seeds a local
 * draft from `currentValue` whenever the dialog opens, and only closes once `onSave`
 * resolves — so a rejected mutation leaves the dialog open with its draft intact
 * instead of silently discarding the failed change.
 */
export function ValueEditDialog<T>({
  open,
  currentValue,
  title,
  description,
  onOpenChange,
  onSave,
  isValid,
  children,
}: ValueEditDialogProps<T>) {
  const [value, setValue] = useState(currentValue);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(currentValue);
      setSaving(false);
    }
  }, [open, currentValue]);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(value);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children(value, setValue)}
        <DialogFooter>
          <Button onClick={handleSave} disabled={saving || (isValid ? !isValid(value) : false)}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
