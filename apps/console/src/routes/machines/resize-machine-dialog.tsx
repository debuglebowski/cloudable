import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { machinesKeys, resizeMachine } from "@/api/machines";
import { useProviderCatalog } from "@/api/provider-catalog";
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

import { MachineSizeBrowser } from "./machine-size-browser";

/**
 * Asks for a new size. An approver signs it off first (`machine_resize`); then the machine
 * is stopped, given the new size and started again. Home and data stay.
 */
export function ResizeMachineDialog({
  open,
  onOpenChange,
  machine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machine: { id: string; sizeSku: string; image: string };
}) {
  const queryClient = useQueryClient();
  const sizesQuery = useProviderCatalog("azure", "sku");
  const imagesQuery = useProviderCatalog("azure", "image");
  const [sizeSku, setSizeSku] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const selectedImage = (imagesQuery.data ?? []).find((i) => i.code === machine.image) ?? null;

  const ask = useMutation({
    mutationFn: () => resizeMachine(machine.id, { sizeSku: sizeSku ?? "", reason: reason.trim() }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      toast.success(result.status === "approved" ? "Resizing" : "Approval requested", {
        description:
          result.status === "approved"
            ? "The machine restarts on the new size in a few minutes."
            : "An approver signs it off on the Approvals page. Then the machine restarts on the new size.",
      });
      close();
    },
  });

  function close() {
    setSizeSku(null);
    setReason("");
    ask.reset();
    onOpenChange(false);
  }

  const ready = sizeSku !== null && sizeSku !== machine.sizeSku && reason.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-[900px]">
        <DialogHeader>
          <DialogTitle>Change size</DialogTitle>
          <DialogDescription>
            Now {machine.sizeSku}. After approval the machine stops for a few minutes, gets the new
            size and starts again. Home and data stay.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          <MachineSizeBrowser
            sizes={sizesQuery.data ?? []}
            isLoading={sizesQuery.isPending}
            selectedSizeSku={sizeSku}
            onSelectSize={setSizeSku}
            selectedImage={selectedImage}
            onSync={() => undefined}
            isSyncing={false}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="resize-reason">Why, for the approver</Label>
            <Input
              id="resize-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Builds and tests are throttled on the current size"
            />
          </div>
          {ask.isError && <p className="text-sm text-destructive">{ask.error.message}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={!ready || ask.isPending} onClick={() => ask.mutate()}>
            {ask.isPending ? "Asking…" : `Ask for ${sizeSku ?? "a size"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
