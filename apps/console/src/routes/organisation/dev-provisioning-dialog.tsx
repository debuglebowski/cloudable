import { useId } from "react";

import type { ProvisioningAdapter } from "@/api/dev-provisioning";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import { ValueEditDialog } from "./value-edit-dialog";

const PROVISIONING_ADAPTERS: ProvisioningAdapter[] = ["azure", "docker", "fake"];
const PROVISIONING_ADAPTER_DESCRIPTION: Record<ProvisioningAdapter, string> = {
  azure: "Cloud provider (Azure) — no real Azure account in this build; every call fails.",
  docker: "Local Docker — real containers on this machine, running the real agent binary.",
  fake: "Fake — in-memory, no real infra.",
};

export interface ProvisioningAdapterDialogProps {
  open: boolean;
  currentAdapter: ProvisioningAdapter;
  onOpenChange: (open: boolean) => void;
  onSave: (adapter: ProvisioningAdapter) => void | Promise<void>;
}

/** Dev-only — see `api/dev-provisioning.ts`'s header comment. Not a governed org setting. */
export function ProvisioningAdapterDialog({
  open,
  currentAdapter,
  onOpenChange,
  onSave,
}: ProvisioningAdapterDialogProps) {
  const id = useId();

  return (
    <ValueEditDialog<ProvisioningAdapter>
      open={open}
      currentValue={currentAdapter}
      title="Provisioning adapter"
      description="Dev-only — controls which backend new/archived/reconciled machines actually hit on this control-plane. Never available against a real (Azure-booted) deployment."
      onOpenChange={onOpenChange}
      onSave={onSave}
    >
      {(adapter, setAdapter) => (
        <RadioGroup
          value={adapter}
          onValueChange={(value) => setAdapter(value as ProvisioningAdapter)}
          aria-label="Provisioning adapter"
        >
          {PROVISIONING_ADAPTERS.map((candidate) => (
            <div key={candidate} className="flex items-start gap-2 text-sm">
              <RadioGroupItem value={candidate} id={`${id}-${candidate}`} className="mt-0.5" />
              <Label htmlFor={`${id}-${candidate}`} className="font-normal">
                {PROVISIONING_ADAPTER_DESCRIPTION[candidate]}
              </Label>
            </div>
          ))}
        </RadioGroup>
      )}
    </ValueEditDialog>
  );
}
