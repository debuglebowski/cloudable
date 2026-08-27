import { useState } from "react";

import { type LiveCertificate, useRevokeCertificate } from "@/api/access";
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

interface RevokeCertificateDialogProps {
  certificate: LiveCertificate | null;
  onOpenChange: (open: boolean) => void;
}

/** Revoke requires a reason — there is no path to revoke without one. */
export function RevokeCertificateDialog({
  certificate,
  onOpenChange,
}: RevokeCertificateDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const revokeCertificate = useRevokeCertificate();

  function handleOpenChange(open: boolean) {
    if (!open) {
      setReason("");
      setError(null);
    }
    onOpenChange(open);
  }

  async function handleConfirm() {
    if (!certificate || reason.trim().length === 0) return;
    setError(null);
    try {
      await revokeCertificate.mutateAsync({ id: certificate.id, reason: reason.trim() });
      handleOpenChange(false);
    } catch {
      setError("Couldn't revoke this certificate. Try again.");
    }
  }

  return (
    <Dialog open={certificate != null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke certificate</DialogTitle>
          <DialogDescription>
            {certificate &&
              `Revokes ${certificate.personName}'s certificate for ${certificate.machineScopeLabel}. This cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="revoke-reason" className="text-sm font-medium">
            Reason <span className="text-destructive">(required)</span>
          </label>
          <Input
            id="revoke-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this certificate being revoked?"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={reason.trim().length === 0 || revokeCertificate.isPending}
            onClick={handleConfirm}
          >
            Revoke certificate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
