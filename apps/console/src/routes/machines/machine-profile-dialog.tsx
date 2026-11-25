import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { machinesKeys } from "@/api/machines";
import { profileKeys, setMachineProfile, useProfiles } from "@/api/profiles";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NO_PROFILE = "none";

/**
 * Moves a machine to another profile, or off one. Admin only, and recorded. A profile that
 * sets a different provider, region, size or image is refused by the server: those are fixed
 * when a machine is created.
 */
export function MachineProfileDialog({
  open,
  onOpenChange,
  machineId,
  currentProfileId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineId: string;
  currentProfileId: string | null;
}) {
  const queryClient = useQueryClient();
  const profilesQuery = useProfiles({ enabled: open });
  const usable = (profilesQuery.data ?? []).filter((p) => p.archivedAt === null);
  const [target, setTarget] = useState(currentProfileId ?? NO_PROFILE);

  useEffect(() => {
    if (open) setTarget(currentProfileId ?? NO_PROFILE);
  }, [open, currentProfileId]);

  const move = useMutation({
    mutationFn: () => setMachineProfile(machineId, target === NO_PROFILE ? null : target),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.all });
      void queryClient.invalidateQueries({ queryKey: profileKeys.all });
      toast.success("Profile changed");
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) move.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change profile</DialogTitle>
          <DialogDescription>
            The machine's settings and packages then come from the new profile, unless it overrides
            them. The change is recorded.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <Label htmlFor="machine-profile">Profile</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id="machine-profile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PROFILE}>No profile</SelectItem>
              {usable.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {move.isError && <p className="text-sm text-destructive">{move.error.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={move.isPending || target === (currentProfileId ?? NO_PROFILE)}
            onClick={() => move.mutate()}
          >
            {move.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
