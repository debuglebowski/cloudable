import { EVENTS_RETENTION_DEFAULT_DAYS, EVENTS_RETENTION_MIN_DAYS } from "@cloudable/contracts";
import { useId } from "react";

import { CONTROL_STATUSES, CONTROL_STATUS_LABELS, type ControlStatus } from "@/api/compliance";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

import { ValueEditDialog } from "./value-edit-dialog";

const APPROVAL_MODES: ApprovalMode[] = ["none", "single", "dual"];
const APPROVAL_MODE_DESCRIPTION: Record<ApprovalMode, string> = {
  none: "None: no approval needed",
  single: "Single: one approver",
  dual: "Dual: two approvers",
};

export interface ApprovalModeDialogProps {
  actionType: ApprovalActionType | null;
  currentMode: ApprovalMode | undefined;
  onOpenChange: (open: boolean) => void;
  onSave: (
    actionType: ApprovalActionType,
    mode: ApprovalMode,
    reason: string,
  ) => void | Promise<void>;
}

/**
 * Approval mode is policy, per action type: none / single / dual. A change does not apply
 * straight away: it becomes a request an approver must sign off, so it needs a reason.
 */
export function ApprovalModeDialog({
  actionType,
  currentMode,
  onOpenChange,
  onSave,
}: ApprovalModeDialogProps) {
  const id = useId();
  const current = currentMode ?? "none";

  return (
    <ValueEditDialog<{ mode: ApprovalMode; reason: string }>
      open={actionType != null}
      currentValue={{ mode: current, reason: "" }}
      title={`${actionType ? APPROVAL_ACTION_LABELS[actionType] : ""}: approval mode`}
      description="Changing this needs an approver's sign-off. It applies once they approve."
      onOpenChange={onOpenChange}
      isValid={(value) => value.mode !== current && value.reason.trim().length > 0}
      onSave={(value) => {
        if (actionType) return onSave(actionType, value.mode, value.reason.trim());
      }}
    >
      {(value, setValue) => (
        <div className="flex flex-col gap-4">
          <RadioGroup
            value={value.mode}
            onValueChange={(mode) => setValue({ ...value, mode: mode as ApprovalMode })}
            aria-label="Approval mode"
          >
            {APPROVAL_MODES.map((candidate) => (
              <div key={candidate} className="flex items-center gap-2 text-sm">
                <RadioGroupItem value={candidate} id={`${id}-${candidate}`} />
                <Label htmlFor={`${id}-${candidate}`} className="font-normal">
                  {APPROVAL_MODE_DESCRIPTION[candidate]}
                </Label>
              </div>
            ))}
          </RadioGroup>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-reason`}>Reason</Label>
            <Textarea
              id={`${id}-reason`}
              rows={2}
              value={value.reason}
              onChange={(event) => setValue({ ...value, reason: event.target.value })}
              placeholder="Why change it? The approver sees this."
            />
          </div>
        </div>
      )}
    </ValueEditDialog>
  );
}

const LOGGING_TIERS: LoggingTier[] = [1, 2];

export interface LoggingTierDialogProps {
  open: boolean;
  currentTier: LoggingTier;
  onOpenChange: (open: boolean) => void;
  onSave: (tier: LoggingTier) => void | Promise<void>;
}

export function LoggingTierDialog({
  open,
  currentTier,
  onOpenChange,
  onSave,
}: LoggingTierDialogProps) {
  const id = useId();

  return (
    <ValueEditDialog<LoggingTier>
      open={open}
      currentValue={currentTier}
      title="Logging tier"
      description="Per-template tier; cost follows."
      onOpenChange={onOpenChange}
      onSave={onSave}
    >
      {(tier, setTier) => (
        <RadioGroup
          value={String(tier)}
          onValueChange={(value) => setTier(Number(value) as LoggingTier)}
          aria-label="Logging tier"
        >
          {LOGGING_TIERS.map((candidate) => (
            <div key={candidate} className="flex items-start gap-2 text-sm">
              <RadioGroupItem
                value={String(candidate)}
                id={`${id}-${candidate}`}
                className="mt-0.5"
              />
              <Label htmlFor={`${id}-${candidate}`} className="font-normal">
                {LOGGING_TIER_LABELS[candidate]}
              </Label>
            </div>
          ))}
        </RadioGroup>
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

/** Snapshot data retention, org-configurable. Whole days only. */
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
      title="Snapshot retention"
      description="How long a snapshot's volume data is kept before it is deleted."
      onOpenChange={onOpenChange}
      onSave={onSave}
      isValid={(days) => Number.isInteger(days) && days >= 1}
    >
      {(days, setDays) => (
        <div className="flex flex-col gap-1">
          <Label htmlFor={inputId}>Retention days</Label>
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

export interface EventRetentionDialogProps {
  open: boolean;
  currentDays: number;
  onOpenChange: (open: boolean) => void;
  onSave: (days: number) => void | Promise<void>;
}

/** How long events are kept. Whole days, never below the floor the control plane enforces. */
export function EventRetentionDialog({
  open,
  currentDays,
  onOpenChange,
  onSave,
}: EventRetentionDialogProps) {
  const inputId = useId();

  return (
    <ValueEditDialog<number>
      open={open}
      currentValue={currentDays}
      title="Event retention"
      description="Events older than this are deleted for good, and compliance checks and the evidence export only see what is kept. A machine with a snapshot under legal hold keeps its events."
      onOpenChange={onOpenChange}
      onSave={onSave}
      isValid={(days) => Number.isInteger(days) && days >= EVENTS_RETENTION_MIN_DAYS}
    >
      {(days, setDays) => (
        <div className="flex flex-col gap-1">
          <Label htmlFor={inputId}>Retention days</Label>
          <Input
            id={inputId}
            type="number"
            step={1}
            min={EVENTS_RETENTION_MIN_DAYS}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          />
          <p className="text-xs text-muted-foreground">
            Minimum {EVENTS_RETENTION_MIN_DAYS} days. Default {EVENTS_RETENTION_DEFAULT_DAYS}.
          </p>
        </div>
      )}
    </ValueEditDialog>
  );
}

const RETENTION_LOCATIONS: RetentionLocation[] = ["customer", "cloudable_sweden_central"];

export interface RetentionLocationDialogProps {
  open: boolean;
  currentLocation: RetentionLocation;
  onOpenChange: (open: boolean) => void;
  onSave: (location: RetentionLocation) => void | Promise<void>;
}

/** Single org-wide value, no per-machine variant — residency is a DPA matter. */
export function RetentionLocationDialog({
  open,
  currentLocation,
  onOpenChange,
  onSave,
}: RetentionLocationDialogProps) {
  const id = useId();

  return (
    <ValueEditDialog<RetentionLocation>
      open={open}
      currentValue={currentLocation}
      title="Log retention location"
      description="Org-wide only — there is no per-machine variant. Residency changes are a DPA matter, not a toggle."
      onOpenChange={onOpenChange}
      onSave={onSave}
    >
      {(location, setLocation) => (
        <RadioGroup
          value={location}
          onValueChange={(value) => setLocation(value as RetentionLocation)}
          aria-label="Log retention location"
        >
          {RETENTION_LOCATIONS.map((candidate) => (
            <div key={candidate} className="flex items-center gap-2 text-sm">
              <RadioGroupItem value={candidate} id={`${id}-${candidate}`} />
              <Label htmlFor={`${id}-${candidate}`} className="font-normal">
                {RETENTION_LOCATION_LABELS[candidate]}
              </Label>
            </div>
          ))}
        </RadioGroup>
      )}
    </ValueEditDialog>
  );
}

/** Sentinel for "no explicit override — use Cloudable's computed default", the one choice
 * that isn't a real `ControlStatus`. Saved as `status: null` (see `useSetControlOverride`). */
const USE_COMPUTED_DEFAULT = "default" as const;
type ControlOverrideChoice = ControlStatus | typeof USE_COMPUTED_DEFAULT;

export interface ControlOverrideDialogProps {
  controlId: string | null;
  controlLabel: string;
  /** The control's current status as returned by the control map — already reflects any
   * existing override. */
  currentStatus: ControlStatus;
  currentlyOverridden: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (controlId: string, status: ControlStatus | null) => void | Promise<void>;
}

/**
 * A control's status is computed by default — this only lets an org flip a specific
 * control to its own explicit choice, never edits the computation itself.
 * "Use Cloudable's computed default" clears any existing override for this control.
 */
export function ControlOverrideDialog({
  controlId,
  controlLabel,
  currentStatus,
  currentlyOverridden,
  onOpenChange,
  onSave,
}: ControlOverrideDialogProps) {
  const id = useId();

  return (
    <ValueEditDialog<ControlOverrideChoice>
      open={controlId != null}
      currentValue={currentlyOverridden ? currentStatus : USE_COMPUTED_DEFAULT}
      title={`${controlLabel} — status override`}
      description="Cloudable computes a default status from its registered compliance checks. Override it for your own framework or auditor — this never changes the computation itself, only what this org reports."
      onOpenChange={onOpenChange}
      onSave={(choice) => {
        if (controlId) return onSave(controlId, choice === USE_COMPUTED_DEFAULT ? null : choice);
      }}
    >
      {(choice, setChoice) => (
        <RadioGroup
          value={choice}
          onValueChange={(value) => setChoice(value as ControlOverrideChoice)}
          aria-label="Control status"
        >
          <div className="flex items-center gap-2 text-sm">
            <RadioGroupItem value={USE_COMPUTED_DEFAULT} id={`${id}-default`} />
            <Label htmlFor={`${id}-default`} className="font-normal">
              Use Cloudable's computed default
            </Label>
          </div>
          {CONTROL_STATUSES.map((candidate) => (
            <div key={candidate} className="flex items-center gap-2 text-sm">
              <RadioGroupItem value={candidate} id={`${id}-${candidate}`} />
              <Label htmlFor={`${id}-${candidate}`} className="font-normal">
                {CONTROL_STATUS_LABELS[candidate]}
              </Label>
            </div>
          ))}
        </RadioGroup>
      )}
    </ValueEditDialog>
  );
}
