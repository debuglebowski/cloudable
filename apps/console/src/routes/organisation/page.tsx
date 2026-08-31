import { useState } from "react";

import { CONTROL_STATUS_LABELS, useControlMap, useSetControlOverride } from "@/api/compliance";
import {
  APPROVAL_ACTION_LABELS,
  APPROVAL_ACTION_TYPES,
  type ApprovalActionType,
  LOGGING_TIER_LABELS,
  RETENTION_LOCATION_LABELS,
  useOrgSettings,
  useUpdateOrgSettings,
} from "@/api/organisation";
import { LineageGutter } from "@/components/lineage-gutter";
import { SettingRow } from "@/components/setting-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { OrgPackageManifestCard } from "./org-package-manifest-card";

import {
  ApprovalModeDialog,
  ControlOverrideDialog,
  LoggingTierDialog,
  RegionDefaultDialog,
  RetentionDaysDialog,
  RetentionLocationDialog,
} from "./setting-dialogs";

function formatMode(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export function OrganisationPage() {
  const { data: settings, isLoading } = useOrgSettings();
  const update = useUpdateOrgSettings();
  const { data: controlMap, isLoading: controlMapLoading } = useControlMap();
  const setControlOverride = useSetControlOverride();

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [editingApproval, setEditingApproval] = useState<ApprovalActionType | null>(null);
  const [editingLoggingTier, setEditingLoggingTier] = useState(false);
  const [editingRetentionDays, setEditingRetentionDays] = useState(false);
  const [editingRetentionLocation, setEditingRetentionLocation] = useState(false);
  const [editingControlId, setEditingControlId] = useState<string | null>(null);
  const [editingRegionDefault, setEditingRegionDefault] = useState(false);

  if (isLoading || !settings) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const editingControl = controlMap?.controls.find((control) => control.id === editingControlId);

  const displayedName = nameDraft ?? settings.name;
  const trimmedNameDraft = nameDraft?.trim() ?? null;
  const canSaveName =
    nameDraft != null &&
    trimmedNameDraft !== "" &&
    trimmedNameDraft !== settings.name &&
    !update.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Organisation</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Org-wide identity and defaults. These settings are policy, inherited down through
          templates and machines (docs/spec.md §5).
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Organisation name</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <label htmlFor="org-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="org-name"
              value={displayedName}
              onChange={(event) => setNameDraft(event.target.value)}
            />
          </div>
          <Button
            disabled={!canSaveName}
            onClick={() => {
              if (trimmedNameDraft) {
                update.mutate({ name: trimmedNameDraft }, { onSuccess: () => setNameDraft(null) });
              }
            }}
          >
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Approvals</CardTitle>
          <CardDescription>
            Approval mode per action type — none, single, or dual approver (docs/spec.md §13).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col">
          {APPROVAL_ACTION_TYPES.map((actionType) => (
            <SettingRow
              key={actionType}
              label={APPROVAL_ACTION_LABELS[actionType]}
              value={formatMode(settings.approvalModes[actionType])}
              source="org"
              onOverride={() => setEditingApproval(actionType)}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Logging</CardTitle>
          <CardDescription>Per-template tier; cost follows (docs/spec.md §17).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <SettingRow
            label="Logging tier"
            value={LOGGING_TIER_LABELS[settings.loggingTier]}
            source="org"
            onOverride={() => setEditingLoggingTier(true)}
          />
          {settings.loggingTierOverrideCount > 0 && (
            <LineageGutter
              source="org"
              viewing="org"
              overriddenBelow={settings.loggingTierOverrideCount}
            />
          )}
          <ul className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <li>Tier 1 — metadata only: provisioning, auth, lifecycle.</li>
            <li>Tier 2 — session-level: connections, elevations, config changes.</li>
            <li>
              Tier 3 — full command capture.{" "}
              <span className="font-medium text-drift">
                Cloudable is on the plaintext path at tier 3.
              </span>{" "}
              Tiers 1 and 2 stay off it — the tunnel passes TLS through untouched.
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Retention</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col">
          <SettingRow
            label="Default retention"
            value={`${settings.retentionDefaultDays} days`}
            source="org"
            onOverride={() => setEditingRetentionDays(true)}
          />
          <SettingRow
            label="Log retention location"
            value={RETENTION_LOCATION_LABELS[settings.retentionLocation]}
            source="org"
            onOverride={() => setEditingRetentionLocation(true)}
          />
          <p className="pt-2 text-xs text-muted-foreground">
            Single org-wide value — no per-machine variant. Residency changes are a DPA matter, not
            a toggle (docs/spec.md §17).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Region</CardTitle>
          <CardDescription>
            Default Azure region for a new machine that doesn't specify one (docs/spec.md §5).
            Resolved live at creation time through the same org → template → machine chain as every
            other setting — never copied onto the machine as a wizard prefill.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col">
          <SettingRow
            label="Default region"
            value={settings.regionDefault}
            source="org"
            onOverride={() => setEditingRegionDefault(true)}
          />
        </CardContent>
      </Card>

      <OrgPackageManifestCard />

      <Card>
        <CardHeader>
          <CardTitle>Compliance controls</CardTitle>
          <CardDescription>
            Cloudable computes a default status per control from its registered compliance checks;
            override one for your own framework or auditor (docs/spec.md §19).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col">
          {controlMapLoading || !controlMap ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            controlMap.controls.map((control) => (
              <SettingRow
                key={control.id}
                label={`${control.label} (${control.framework})`}
                value={
                  CONTROL_STATUS_LABELS[control.status] + (control.overridden ? " — override" : "")
                }
                source="org"
                // Out-of-scope controls (overridable: false) never show an Override
                // action — the backend always rejects an override attempt for one, so
                // offering the button here would just be a guaranteed-to-fail affordance.
                // Spread rather than `onOverride={... : undefined}`: the prop is optional
                // under `exactOptionalPropertyTypes`, which means "present or absent", not
                // "present, possibly with value undefined".
                {...(control.overridable
                  ? { onOverride: () => setEditingControlId(control.id) }
                  : {})}
              />
            ))
          )}
        </CardContent>
      </Card>

      <ApprovalModeDialog
        actionType={editingApproval}
        currentMode={editingApproval ? settings.approvalModes[editingApproval] : undefined}
        onOpenChange={(open) => {
          if (!open) setEditingApproval(null);
        }}
        onSave={async (actionType, mode) => {
          await update.mutateAsync({
            approvalModes: { ...settings.approvalModes, [actionType]: mode },
          });
        }}
      />
      <LoggingTierDialog
        open={editingLoggingTier}
        currentTier={settings.loggingTier}
        onOpenChange={setEditingLoggingTier}
        onSave={async (tier) => {
          await update.mutateAsync({ loggingTier: tier });
        }}
      />
      <RetentionDaysDialog
        open={editingRetentionDays}
        currentDays={settings.retentionDefaultDays}
        onOpenChange={setEditingRetentionDays}
        onSave={async (days) => {
          await update.mutateAsync({ retentionDefaultDays: days });
        }}
      />
      <RetentionLocationDialog
        open={editingRetentionLocation}
        currentLocation={settings.retentionLocation}
        onOpenChange={setEditingRetentionLocation}
        onSave={async (location) => {
          await update.mutateAsync({ retentionLocation: location });
        }}
      />
      <RegionDefaultDialog
        open={editingRegionDefault}
        currentRegion={settings.regionDefault}
        onOpenChange={setEditingRegionDefault}
        onSave={async (region) => {
          await update.mutateAsync({ regionDefault: region });
        }}
      />
      <ControlOverrideDialog
        controlId={editingControl ? editingControl.id : null}
        controlLabel={editingControl?.label ?? ""}
        currentStatus={editingControl?.status ?? "manual_action_required"}
        currentlyOverridden={editingControl?.overridden ?? false}
        onOpenChange={(open) => {
          if (!open) setEditingControlId(null);
        }}
        onSave={async (controlId, status) => {
          await setControlOverride.mutateAsync({ controlId, status });
        }}
      />
    </div>
  );
}
