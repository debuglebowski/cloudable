import { Building2 } from "lucide-react";
import { Fragment, useState } from "react";

import { useDevProvisioningAdapter, useSetDevProvisioningAdapter } from "@/api/dev-provisioning";
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
import { PageHeaderIcon } from "@/components/page-header-icon";
import { SettingRow } from "@/components/setting-row";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { ProvisioningAdapterDialog } from "./dev-provisioning-dialog";
import {
  ApprovalModeDialog,
  LoggingTierDialog,
  RetentionDaysDialog,
  RetentionLocationDialog,
} from "./setting-dialogs";

/**
 * Dev-only card: lets a developer switch which `ProvisioningService` this
 * console's control-plane dispatches to, without restarting the process
 * (see `api/dev-provisioning.ts`). Gated on `import.meta.env.DEV` (same
 * mechanism as `nav-config.ts`'s dev-time nav check) so it's stripped from
 * a production build entirely — the real enforcement is server-side
 * (`overridable`), this is just the console never offering it for real.
 * Deliberately not a `SettingRow`/`LineageGutter` — those carry
 * org→template→machine inheritance semantics that don't apply here.
 */
function DevProvisioningCard() {
  const { data } = useDevProvisioningAdapter();
  const setAdapter = useSetDevProvisioningAdapter();
  const [editing, setEditing] = useState(false);

  if (!data) return null;

  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle>Provisioning adapter (dev only)</CardTitle>
        <CardDescription>
          Boot default: {data.bootDefault}
          {!data.overridable && " — this control-plane booted as azure and cannot be switched."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <span className="text-sm">
            Current: <span className="font-medium">{data.current}</span>
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!data.overridable}
            onClick={() => setEditing(true)}
          >
            Switch
          </Button>
        </div>
      </CardContent>
      <ProvisioningAdapterDialog
        open={editing}
        currentAdapter={data.current}
        onOpenChange={setEditing}
        onSave={async (adapter) => {
          await setAdapter.mutateAsync(adapter);
        }}
      />
    </Card>
  );
}

function formatMode(mode: string): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export function OrganisationPage() {
  const { data: settings, isLoading } = useOrgSettings();
  const update = useUpdateOrgSettings();

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [editingApproval, setEditingApproval] = useState<ApprovalActionType | null>(null);
  const [editingLoggingTier, setEditingLoggingTier] = useState(false);
  const [editingRetentionDays, setEditingRetentionDays] = useState(false);
  const [editingRetentionLocation, setEditingRetentionLocation] = useState(false);

  if (isLoading || !settings) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const displayedName = nameDraft ?? settings.name;
  const trimmedNameDraft = nameDraft?.trim() ?? null;
  const canSaveName =
    nameDraft != null &&
    trimmedNameDraft !== "" &&
    trimmedNameDraft !== settings.name &&
    !update.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <PageHeaderIcon icon={Building2} />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Organisation</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            Org-wide identity and defaults. These settings are policy, inherited down through
            templates and machines (docs/spec.md §5).
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Organisation name</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="org-name">Name</Label>
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
            <Fragment key={actionType}>
              <SettingRow
                label={APPROVAL_ACTION_LABELS[actionType]}
                value={formatMode(settings.approvalModes[actionType])}
                source="org"
                onOverride={() => setEditingApproval(actionType)}
              />
              {settings.approvalOverrides[actionType] > 0 && (
                <div className="-mt-1 pb-2.5">
                  <LineageGutter
                    source="org"
                    viewing="org"
                    overriddenBelow={settings.approvalOverrides[actionType]}
                  />
                </div>
              )}
            </Fragment>
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

      {import.meta.env.DEV && <DevProvisioningCard />}
    </div>
  );
}
