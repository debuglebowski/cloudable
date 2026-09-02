import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import { type ElevationGrant, useRequestElevation } from "@/api/access";
import { listMachines, machinesKeys } from "@/api/machines";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const LEVELS: ElevationGrant["level"][] = ["file_recovery", "shell"];
const LEVEL_LABEL: Record<ElevationGrant["level"], string> = {
  file_recovery: "File recovery",
  shell: "Shell",
};

/**
 * Real `POST /api/v1/elevations` — admin access to a machine the signed-in
 * person does NOT own. The requester is always the caller's own
 * session, never picked — see `api/access.ts`'s doc comment. Rejected with
 * `SelfOwnedMachineError` server-side if the picked machine is actually
 * theirs; that comes back as a plain error message, not a client-side
 * pre-filter, since the console has no per-person ownership index handy
 * here.
 */
export function RequestElevationDialog() {
  const [open, setOpen] = useState(false);
  const [machineId, setMachineId] = useState("");
  const [level, setLevel] = useState<ElevationGrant["level"]>("file_recovery");
  const [reason, setReason] = useState("");

  const machinesQuery = useQuery({ queryKey: machinesKeys.list(), queryFn: listMachines });
  const mutation = useRequestElevation();

  function reset() {
    setMachineId("");
    setLevel("file_recovery");
    setReason("");
    mutation.reset();
  }

  const reasonTrimmed = reason.trim();
  const canSubmit = machineId.length > 0 && reasonTrimmed.length > 0 && !mutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          Request elevation
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request elevation</DialogTitle>
          <DialogDescription>
            Admin access to a machine you don&apos;t own. Granted immediately, on a delay, or
            denied, depending on this org&apos;s admin-access policy.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="elevation-machine">Machine</Label>
            <Select value={machineId} onValueChange={setMachineId}>
              <SelectTrigger id="elevation-machine">
                <SelectValue
                  placeholder={machinesQuery.isLoading ? "Loading machines…" : "Select a machine"}
                />
              </SelectTrigger>
              <SelectContent>
                {machinesQuery.data?.map((machine) => (
                  <SelectItem key={machine.id} value={machine.id}>
                    {machine.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="elevation-level">Level</Label>
            <Select value={level} onValueChange={(v) => setLevel(v as ElevationGrant["level"])}>
              <SelectTrigger id="elevation-level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {LEVEL_LABEL[l]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="elevation-reason">
              Reason <span className="text-destructive">(required)</span>
            </Label>
            <Textarea
              id="elevation-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="Why do you need this?"
            />
          </div>
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {mutation.error instanceof Error ? mutation.error.message : "Something went wrong."}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              mutation.mutate(
                { machineId, level, reason: reasonTrimmed },
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            {mutation.isPending ? "Requesting…" : "Request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
