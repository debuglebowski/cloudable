/**
 * The prompts the file interface needs, as real dialogs.
 *
 * These replace native `confirm()` and `prompt()`, which this component was the only place
 * in the console to use. Beyond being out of step with every other flow here, a native
 * prompt cannot be styled, cannot be dismissed with the app's own affordances, and blocks
 * the whole tab — which matters more than usual on this page, because a files session is a
 * live websocket that keeps receiving frames while a modal dialog is up.
 */
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface TextPromptProps {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  initialValue?: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onOpenChange: (open: boolean) => void;
}

export function TextPromptDialog({
  open,
  title,
  description,
  label,
  initialValue = "",
  confirmLabel,
  onConfirm,
  onOpenChange,
}: TextPromptProps) {
  const [value, setValue] = useState(initialValue);
  // Reset on each open: the component stays mounted between uses, so without this a rename
  // would pre-fill with whatever was typed the previous time.
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="file-prompt-input">{label}</Label>
          <Input
            id="file-prompt-input"
            value={value}
            autoFocus
            spellCheck={false}
            className="font-mono"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!value.trim()} onClick={submit}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ConfirmProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  onOpenChange,
}: ConfirmProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={destructive ? "bg-destructive text-destructive-foreground" : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
