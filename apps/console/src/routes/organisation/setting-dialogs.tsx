import { useId } from "react";

import {
  APPROVAL_ACTION_LABELS,
  type ApprovalActionType,
  type ApprovalMode,
  LOGGING_TIER_LABELS,
  type LoggingTier,
  RETENTION_LOCATION_LABELS,
  type RetentionLocation,
} from "@/api/organisation";
import { Input } from "@/components/ui/input";

import { ValueEditDialog } from "./value-edit-dialog";

const APPROVAL_MODES: ApprovalMode[] = ["none", "single", "dual"];
const APPROVAL_MODE_DESCRIPTION: Record<ApprovalMode, string> = {
  none: "None — no approval required",
  single: "Single — one approver",
  dual: "Dual — two approvers",
};

export interface ApprovalModeDialogProps {
  actionType: ApprovalActionType | null;
  currentMode: ApprovalMode | undefined;
  onOpenChange: (open: boolean) => void;
  onSave: (actionType: ApprovalActionType, mode: ApprovalMode) => void | Promise<void>;
}

/** Approval mode is policy, per action type: none / single / dual (docs/spec.md §13). */
export function ApprovalModeDialog({
  actionType,
  currentMode,
  onOpenChange,
  onSave,
}: ApprovalModeDialogProps) {
  const name = useId();

  return (
    <ValueEditDialog<ApprovalMode>
      open={actionType != null}
      currentValue={currentMode ?? "none"}
      title={`${actionType ? APPROVAL_ACTION_LABELS[actionType] : ""} — approval mode`}
      description="Inherited through org → template → machine (docs/spec.md §13). A confirmation dialog is self-approval and is not an approval."
      onOpenChange={onOpenChange}
      onSave={(mode) => {
        if (actionType) return onSave(actionType, mode);
      }}
    >
      {(mode, setMode) => (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Approval mode</legend>
          {APPROVAL_MODES.map((candidate) => (
            <label key={candidate} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={name}
                value={candidate}
                checked={mode === candidate}
                onChange={() => setMode(candidate)}
              />
              {APPROVAL_MODE_DESCRIPTION[candidate]}
            </label>
          ))}
        </fieldset>
      )}
    </ValueEditDialog>
  );
}

const LOGGING_TIERS: LoggingTier[] = [1, 2, 3];

export interface LoggingTierDialogProps {
  open: boolean;
  currentTier: LoggingTier;
  onOpenChange: (open: boolean) => void;
  onSave: (tier: LoggingTier) => void | Promise<void>;
}

/** Tier 3's plaintext-path consequence is stated here too, not just on the page (docs/spec.md §17). */
export function LoggingTierDialog({
  open,
  currentTier,
  onOpenChange,
  onSave,
}: LoggingTierDialogProps) {
  const name = useId();

  return (
    <ValueEditDialog<LoggingTier>
      open={open}
      currentValue={currentTier}
      title="Logging tier"
      description="Per-template tier; cost follows (docs/spec.md §17)."
      onOpenChange={onOpenChange}
      onSave={onSave}
    >
      {(tier, setTier) => (
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Logging tier</legend>
          {LOGGING_TIERS.map((candidate) => (
            <label key={candidate} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={name}
                className="mt-0.5"
                value={candidate}
                checked={tier === candidate}
                onChange={() => setTier(candidate)}
              />
              <span>
                {LOGGING_TIER_LABELS[candidate]}
                {candidate === 3 && (
                  <>
                    {" — "}
                    <span className="font-medium text-drift">
                      Cloudable is on the plaintext path.
                    </span>{" "}
                    Tiers 1 and 2 stay off it; the tunnel passes TLS through untouched.
                  </>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </ValueEditDialog>
  );
}

export interface RetentionDaysDialogProps {
  open: boolean;
  currentDays: number;
  onOpenChange: (open: boolean) => void;
  onSave: (days: number) => void | Promise<void>;
}

/** Retention default, org-configurable (docs/spec.md §14). Whole days only. */
export function RetentionDaysDialog({
  open,
  currentDays,
  onOpenChange,
  onSave,
}: RetentionDaysDialogProps) {
  const inputId = useId();

  return (
    <ValueEditDialog<number>
      open={open}
      currentValue={currentDays}
      title="Default retention"
      description="Applies org-wide unless a template overrides it (docs/spec.md §5)."
      onOpenChange={onOpenChange}
      onSave={onSave}
      isValid={(days) => Number.isInteger(days) && days >= 1}
    >
      {(days, setDays) => (
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="text-sm font-medium">
            Retention days
          </label>
          <Input
            id={inputId}
            type="number"
            step={1}
            min={1}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          />
        </div>
      )}
    </ValueEditDialog>
  );
}

const RETENTION_LOCATIONS: RetentionLocation[] = [
  "customer_controlled",
  "cloudable_held_sweden_central",
];

export interface RetentionLocationDialogProps {
  open: boolean;
  currentLocation: RetentionLocation;
  onOpenChange: (open: boolean) => void;
  onSave: (location: RetentionLocation) => void | Promise<void>;
}

/** Single org-wide value, no per-machine variant — residency is a DPA matter (docs/spec.md §17). */
export function RetentionLocationDialog({
  open,
  currentLocation,
  onOpenChange,
  onSave,
}: RetentionLocationDialogProps) {
  const name = useId();

  return (
    <ValueEditDialog<RetentionLocation>
      open={open}
      currentValue={currentLocation}
      title="Log retention location"
      description="Org-wide only — there is no per-machine variant. Residency changes are a DPA matter, not a toggle (docs/spec.md §17)."
      onOpenChange={onOpenChange}
      onSave={onSave}
    >
      {(location, setLocation) => (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Log retention location</legend>
          {RETENTION_LOCATIONS.map((candidate) => (
            <label key={candidate} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={name}
                value={candidate}
                checked={location === candidate}
                onChange={() => setLocation(candidate)}
              />
              {RETENTION_LOCATION_LABELS[candidate]}
            </label>
          ))}
        </fieldset>
      )}
    </ValueEditDialog>
  );
}
