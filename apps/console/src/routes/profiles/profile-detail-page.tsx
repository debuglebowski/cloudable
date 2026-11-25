import type { AccessMethodsEnabled, ProfileDetail } from "@cloudable/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  profileErrorMessage,
  profileKeys,
  setProfileSetting,
  useArchiveProfile,
  useProfile,
  useProfiles,
  useSetProfileBase,
  useUpdateProfile,
} from "@/api/profiles";
import { PageLoader } from "@/components/page-loader";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { OrgPackageManifestCard } from "../organisation/org-package-manifest-card";
import { ProfileFormDialog } from "./profile-form-dialog";
import {
  ACCESS_METHOD_KEYS,
  PROFILE_SETTINGS,
  type ProfileSettingKey,
  type ProfileSettingSpec,
  accessMethodLabel,
  describeSettingValue,
} from "./profile-settings";
import { creationFieldsSummary } from "./profiles-page";

const CREATION_FIELD_ROWS = [
  { field: "provider", label: "Provider" },
  { field: "region", label: "Region" },
  { field: "sizeSku", label: "Size" },
  { field: "image", label: "Image" },
] as const;

export function ProfileDetailPage() {
  const { profileId } = useParams({ from: "/profiles/$profileId" });
  const queryClient = useQueryClient();
  const profileQuery = useProfile(profileId);
  const update = useUpdateProfile(profileId);
  const archive = useArchiveProfile(profileId);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [editingSetting, setEditingSetting] = useState<ProfileSettingSpec | null>(null);

  if (profileQuery.isPending) return <PageLoader />;
  const profile = profileQuery.data;
  if (!profile) {
    return (
      <EmptyState icon={Layers} title="Profile not found" description="It may be in another org." />
    );
  }
  const archived = profile.archivedAt !== null;
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: profileKeys.all });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link to="/profiles" className="hover:text-foreground hover:underline">
          Profiles
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-foreground">{profile.name}</span>
      </div>
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{profile.name}</h1>
        {archived ? <Badge variant="outline">Archived</Badge> : <Badge variant="ok">Active</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={archived} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={archived || profile.extendedBy > 0}
            title={
              profile.extendedBy > 0
                ? "Other profiles extend this one. Change their base before archiving it."
                : undefined
            }
            onClick={() => setArchiving(true)}
          >
            Archive
          </Button>
        </div>
      </div>
      {profile.description && (
        <p className="-mt-4 max-w-prose text-sm text-muted-foreground">{profile.description}</p>
      )}
      {archived && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Archived. No new machine can use it. The {profile.machineCount} machine(s) on it keep its
          settings until an admin moves them.
        </p>
      )}

      <BaseProfileCard profile={profile} disabled={archived} />

      <Card>
        <CardHeader>
          <CardTitle>New machines</CardTitle>
          <CardDescription>
            Used when a machine is created. A starting value fills in the Add machine form, and the
            person can change it. A locked value is the same on every machine on this profile.
            Editing these never changes a machine that already exists.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {creationFieldsSummary(profile) === "—" ? (
            <span className="text-muted-foreground">
              None. The Add machine form asks for the provider, region, size and image.
            </span>
          ) : (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5">
              {CREATION_FIELD_ROWS.map(({ field, label }) => {
                const resolved = profile.creation[field];
                if (resolved.value === null) return null;
                return (
                  <div key={field} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="flex items-center gap-2">
                      <span className="font-mono">{resolved.value}</span>
                      {resolved.locked ? (
                        <Badge variant="outline">Locked</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Starting value</span>
                      )}
                      {resolved.fromProfileId !== null && resolved.fromProfileId !== profile.id && (
                        <span className="text-xs text-muted-foreground">
                          from base {profile.baseProfileName}
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>
            What the profile does not set, its machines take from{" "}
            {profile.baseProfileName ? `its base, ${profile.baseProfileName}, or ` : ""}the org. A
            locked setting cannot be overridden on a machine.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col">
          {PROFILE_SETTINGS.map((spec) => (
            <ProfileSettingRow
              key={spec.key}
              spec={spec}
              profile={profile}
              disabled={archived}
              onEdit={() => setEditingSetting(spec)}
              onCleared={invalidate}
            />
          ))}
        </CardContent>
      </Card>

      <OrgPackageManifestCard profileId={profile.id} readOnly={archived} />

      <ProfileFormDialog
        open={editing}
        onOpenChange={setEditing}
        profile={profile}
        save={(values) => update.mutateAsync(values)}
        onSaved={() => toast.success("Profile updated")}
      />

      <SettingDialog
        spec={editingSetting}
        profile={profile}
        onOpenChange={(open) => {
          if (!open) setEditingSetting(null);
        }}
        onSaved={invalidate}
      />

      <AlertDialog open={archiving} onOpenChange={setArchiving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive "{profile.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              No new machine can use it. The {profile.machineCount} machine(s) on it keep its
              settings. A profile cannot be unarchived.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={archive.isPending}
              onClick={(event) => {
                event.preventDefault();
                archive.mutate(undefined, {
                  onSuccess: () => {
                    setArchiving(false);
                    toast.success("Profile archived");
                  },
                  onError: (error) =>
                    toast.error("Couldn't archive it", {
                      description: profileErrorMessage(error),
                    }),
                });
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProfileSettingRow({
  spec,
  profile,
  disabled,
  onEdit,
  onCleared,
}: {
  spec: ProfileSettingSpec;
  profile: ProfileDetail;
  disabled: boolean;
  onEdit: () => void;
  onCleared: () => void;
}) {
  const own = profile.settings.find((s) => s.key === spec.key);
  const fromBase = profile.base?.settings.find((s) => s.key === spec.key);
  const inheritedFrom = fromBase ? `base ${profile.base?.name}` : "the org";
  // A base lock binds this profile too: it cannot set its own value.
  const lockedByBase = Boolean(fromBase?.locked);
  const clear = useMutation({
    mutationFn: () => setProfileSetting(profile.id, { key: spec.key, value: null, clear: true }),
    onSuccess: () => {
      onCleared();
      toast.success(`${spec.label} now comes from ${inheritedFrom}`);
    },
    onError: (error) => toast.error("Couldn't clear it", { description: error.message }),
  });

  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{spec.label}</span>
        <span className="text-xs text-muted-foreground">{spec.help}</span>
      </div>
      <div className="flex items-center gap-3">
        {own ? (
          <>
            <span className="text-sm">{describeSettingValue(spec.key, own.value)}</span>
            {own.locked && <Badge variant="outline">locked</Badge>}
          </>
        ) : fromBase ? (
          <>
            <span className="text-sm">{describeSettingValue(spec.key, fromBase.value)}</span>
            <span className="text-xs text-muted-foreground">from base {profile.base?.name}</span>
            {fromBase.locked && <Badge variant="outline">locked</Badge>}
          </>
        ) : (
          <span className="text-sm text-muted-foreground">From the org</span>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || (lockedByBase && !own)}
          title={lockedByBase ? `Locked by base ${profile.base?.name}` : undefined}
          onClick={onEdit}
        >
          {own ? "Edit" : "Set"}
        </Button>
        {own && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || clear.isPending}
            onClick={() => clear.mutate()}
          >
            {fromBase ? "Use the base's" : "Use the org's"}
          </Button>
        )}
      </div>
    </div>
  );
}

const DEFAULT_ACCESS: AccessMethodsEnabled = {
  webTerminal: true,
  ssh: true,
  files: true,
  snapshotInspect: true,
};

/** Edits one profile setting, with its lock. */
function SettingDialog({
  spec,
  profile,
  onOpenChange,
  onSaved,
}: {
  spec: ProfileSettingSpec | null;
  profile: ProfileDetail;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const own = spec ? profile.settings.find((s) => s.key === spec.key) : undefined;
  const [tier, setTier] = useState<1 | 2>(1);
  const [minutes, setMinutes] = useState("60");
  const [access, setAccess] = useState<AccessMethodsEnabled>(DEFAULT_ACCESS);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    if (!spec) return;
    setLocked(own?.locked ?? false);
    if (spec.key === "logging_tier") setTier(own?.value === 2 ? 2 : 1);
    if (spec.key === "admin_access_elevation_ttl_minutes")
      setMinutes(typeof own?.value === "number" ? String(own.value) : "60");
    if (spec.key === "machine.accessMethodsEnabled")
      setAccess({ ...DEFAULT_ACCESS, ...((own?.value ?? {}) as Partial<AccessMethodsEnabled>) });
  }, [spec, own]);

  const valueFor = (key: ProfileSettingKey): unknown => {
    switch (key) {
      case "logging_tier":
        return tier;
      case "admin_access_elevation_ttl_minutes":
        return Number(minutes);
      case "machine.accessMethodsEnabled":
        return access;
    }
  };
  const minutesValid = Number.isInteger(Number(minutes)) && Number(minutes) > 0;

  const save = useMutation({
    mutationFn: () => {
      if (!spec) throw new Error("no setting");
      return setProfileSetting(profile.id, { key: spec.key, value: valueFor(spec.key), locked });
    },
    onSuccess: () => {
      onSaved();
      onOpenChange(false);
      toast.success(`${spec?.label} saved for this profile`);
    },
  });

  return (
    <Dialog
      open={spec !== null}
      onOpenChange={(open) => {
        if (!open) save.reset();
        onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{spec?.label}</DialogTitle>
          <DialogDescription>{spec?.help}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {spec?.key === "logging_tier" && (
            <RadioGroup
              value={String(tier)}
              onValueChange={(value) => setTier(value === "2" ? 2 : 1)}
            >
              {([1, 2] as const).map((value) => (
                <Label key={value} className="flex items-center gap-2 text-sm font-normal">
                  <RadioGroupItem value={String(value)} />
                  {value === 1 ? "Tier 1: metadata only" : "Tier 2: also sessions and changes"}
                </Label>
              ))}
            </RadioGroup>
          )}
          {spec?.key === "admin_access_elevation_ttl_minutes" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor="profile-ttl">Minutes</Label>
              <Input
                id="profile-ttl"
                type="number"
                min={1}
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
              />
            </div>
          )}
          {spec?.key === "machine.accessMethodsEnabled" && (
            <div className="flex flex-col gap-2">
              {ACCESS_METHOD_KEYS.map((key) => (
                <Label key={key} className="flex items-center gap-2 text-sm font-normal">
                  <Checkbox
                    checked={access[key]}
                    onCheckedChange={(checked) =>
                      setAccess((current) => ({ ...current, [key]: checked === true }))
                    }
                  />
                  {accessMethodLabel(key)}
                </Label>
              ))}
              <span className="text-xs text-muted-foreground">
                Turning one off ends its open sessions on every machine this reaches.
              </span>
            </div>
          )}
          <Label className="mt-2 flex items-center gap-2 text-sm font-normal">
            <Checkbox checked={locked} onCheckedChange={(checked) => setLocked(checked === true)} />
            Locked: a machine on this profile cannot override it
          </Label>
          {save.isError && <p className="text-sm text-destructive">{save.error.message}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              save.isPending ||
              (spec?.key === "admin_access_elevation_ttl_minutes" && !minutesValid)
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Select items cannot have an empty value, so "no base" needs a name of its own. */
const NO_BASE = "none";

/**
 * The profile this one extends. Its machines take the base's settings, packages and creation
 * fields, unless this profile sets its own. A base lock binds this profile too. One level only:
 * a base cannot extend another, so the list offers only profiles that extend nothing.
 */
function BaseProfileCard({ profile, disabled }: { profile: ProfileDetail; disabled: boolean }) {
  const profilesQuery = useProfiles();
  const setBase = useSetProfileBase(profile.id);
  const [choice, setChoice] = useState(profile.baseProfileId ?? NO_BASE);
  useEffect(() => setChoice(profile.baseProfileId ?? NO_BASE), [profile.baseProfileId]);

  const candidates = (profilesQuery.data ?? []).filter(
    (p) => p.id !== profile.id && p.archivedAt === null && p.baseProfileId === null,
  );
  const isBase = profile.extendedBy > 0;
  const next = choice === NO_BASE ? null : choice;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Base profile</CardTitle>
        <CardDescription>
          {isBase
            ? `${profile.extendedBy} profile(s) extend this one, so it cannot extend another.`
            : "Extend another profile to take its settings, packages and creation fields. What this profile sets itself wins, unless the base locks it."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 text-sm">
        {profile.baseProfileId && (
          <span>
            Extends{" "}
            <Link
              to="/profiles/$profileId"
              params={{ profileId: profile.baseProfileId }}
              className="font-medium hover:underline"
            >
              {profile.baseProfileName}
            </Link>
            .
          </span>
        )}
        {!isBase && (
          <>
            <Select value={choice} onValueChange={setChoice} disabled={disabled}>
              <SelectTrigger className="w-64" aria-label="Base profile">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_BASE}>No base</SelectItem>
                {candidates.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || setBase.isPending || next === profile.baseProfileId}
              onClick={() =>
                setBase.mutate(next, {
                  onSuccess: () =>
                    toast.success(next ? "Base profile set" : "Base profile cleared"),
                  onError: (error) =>
                    toast.error("Couldn't change the base", {
                      description: profileErrorMessage(error),
                    }),
                })
              }
            >
              Save
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
