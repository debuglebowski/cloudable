import { useMutation } from "@tanstack/react-query";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";

import {
  ManifestOverrideError,
  type PackageEnsureApprovalView,
  type PackageSetting,
} from "@/api/machines";
import { PackageSettingSelect } from "@/components/package-setting-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { refusalReason } from "@/lib/api-client";
import {
  PACKAGE_SETTING_LABELS,
  describeSettingChange,
  settingUnavailableReason,
} from "@/lib/package-setting";

/** What the dialog starts from when it edits an entry. */
export interface PackageEntryValues {
  packageName: string;
  versionPin: string | null;
  partOf: string | null;
  description: string | null;
  setting: PackageSetting;
  /** Org and profile entries only: a level below cannot override a locked entry. */
  locked?: boolean;
}

/** One saved entry, as both write paths take it. */
export interface PackageEntrySave {
  packageName: string;
  versionPin: string | null;
  partOf: string | null;
  description: string | null;
  setting: PackageSetting;
  locked?: boolean;
}

export type PackageEntryDialogMode =
  | { kind: "add" }
  /** `inherited`: the values come from the org or profile, and saving writes this machine's own entry. */
  | { kind: "edit"; values: PackageEntryValues; inherited: boolean };

/**
 * Adds a package to a manifest, or changes an entry already there, for one
 * machine or for the whole org. Every field is sent on save, so what the
 * dialog shows is exactly what is written. Moving to an Ensure setting waits
 * for an approval, like everywhere else.
 */
export function PackageEntryDialog({
  scope,
  save,
  mode,
  onOpenChange,
  takenNames,
  partOfOptions,
  onSaved,
}: {
  /**
   * The org's entries apply to every machine, a profile's to every machine on it; both can be
   * locked. A machine's apply to it alone.
   */
  scope: "machine" | "profile" | "org";
  /** Writes the entry. Returns the approvals any Ensure setting asked for. */
  save: (entry: PackageEntrySave) => Promise<{ ensureApprovals?: PackageEnsureApprovalView[] }>;
  /** Null closes the dialog. */
  mode: PackageEntryDialogMode | null;
  onOpenChange: (open: boolean) => void;
  /** Names this machine already has its own entry for. Adding one of them is refused. */
  takenNames: ReadonlySet<string>;
  /** Declared packages a new entry can be part of. */
  partOfOptions: readonly string[];
  onSaved: () => void;
}) {
  const nameId = useId();
  const versionId = useId();
  const partOfId = useId();
  const descriptionId = useId();
  const settingId = useId();
  const lockedId = useId();
  const [packageName, setPackageName] = useState("");
  const [versionPin, setVersionPin] = useState("");
  const [partOf, setPartOf] = useState("");
  const [description, setDescription] = useState("");
  const [setting, setSetting] = useState<PackageSetting>("allowed");
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start from the entry being edited each time the dialog opens.
  useEffect(() => {
    if (!mode) return;
    const values = mode.kind === "edit" ? mode.values : null;
    setPackageName(values?.packageName ?? "");
    setVersionPin(values?.versionPin ?? "");
    setPartOf(values?.partOf ?? "");
    setDescription(values?.description ?? "");
    setSetting(values?.setting ?? "allowed");
    setLocked(values?.locked ?? false);
    setError(null);
  }, [mode]);

  const saveMutation = useMutation({
    mutationFn: save,
    onSuccess: (result, entry) => {
      onOpenChange(false);
      onSaved();
      const ensureApprovals = result.ensureApprovals ?? [];
      const approval = ensureApprovals.find((a) => a.packageName === entry.packageName);
      if (approval && approval.status !== "approved") {
        // An Ensure setting waits for its approval, and so does the rest of this edit.
        const outcome = describeSettingChange(entry.packageName, entry.setting, ensureApprovals);
        const show = outcome.kind === "success" ? toast.success : toast.error;
        show(outcome.title, outcome.description ? { description: outcome.description } : undefined);
        return;
      }
      const where =
        scope === "org"
          ? "for every machine"
          : scope === "profile"
            ? "for every machine on this profile"
            : "on this machine";
      toast.success(
        mode?.kind === "edit"
          ? `"${entry.packageName}" updated ${where}`
          : `"${entry.packageName}" added ${where}`,
      );
    },
    onError: (err) => {
      setError(
        err instanceof ManifestOverrideError
          ? err.body.error.message
          : (refusalReason(err) ?? err.message ?? "Couldn't save that package."),
      );
    },
  });

  const isEdit = mode?.kind === "edit";
  const trimmedName = packageName.trim();
  const trimmedVersion = versionPin.trim();
  const isDuplicate = !isEdit && takenNames.has(trimmedName);
  // The setting picked first can stop fitting once a name or pin is typed after it.
  const settingProblem = settingUnavailableReason(setting, {
    packageName: trimmedName,
    versionPin: trimmedVersion === "" ? null : trimmedVersion,
  });
  const canSave =
    trimmedName !== "" && !isDuplicate && settingProblem === null && !saveMutation.isPending;

  function submit() {
    if (!canSave) return;
    const trimmedParent = partOf.trim();
    const trimmedDescription = description.trim();
    saveMutation.mutate({
      packageName: trimmedName,
      versionPin: trimmedVersion === "" ? null : trimmedVersion,
      partOf: trimmedParent === "" ? null : trimmedParent,
      description: trimmedDescription === "" ? null : trimmedDescription,
      setting,
      ...(scope !== "machine" ? { locked } : {}),
    });
  }

  const onEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter") submit();
  };

  const title = !isEdit
    ? scope === "org"
      ? "Add a package for every machine"
      : scope === "profile"
        ? "Add a package to this profile"
        : "Add a package to this machine"
    : mode.inherited
      ? `Override "${trimmedName}" on this machine`
      : `Edit "${trimmedName}"`;

  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {!isEdit ? (
              <>
                Not from apt? Prefix it: <code>npm:</code>, <code>pipx:</code>, <code>cargo:</code>{" "}
                for global tools, <code>nix:</code> for a nixpkgs package (its pin is a nixpkgs
                commit), <code>home:</code> for software in the home folder.
              </>
            ) : mode.inherited ? (
              "This package comes from the org or the machine's profile. Saving gives this machine its own entry, which it uses instead. Reset to the inherited entry any time from the row's menu."
            ) : scope === "org" ? (
              "Every machine without its own entry for this package uses this one."
            ) : scope === "profile" ? (
              "Every machine on this profile without its own entry for this package uses this one."
            ) : (
              "This entry belongs to this machine."
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {!isEdit && (
            <Field id={nameId} label="Package">
              <Input
                id={nameId}
                value={packageName}
                onChange={(event) => setPackageName(event.target.value)}
                onKeyDown={onEnter}
                placeholder="ripgrep or npm:playwright"
                autoFocus
              />
            </Field>
          )}
          <Field id={versionId} label="Version pin">
            <Input
              id={versionId}
              value={versionPin}
              onChange={(event) => setVersionPin(event.target.value)}
              onKeyDown={onEnter}
              placeholder="any"
              autoFocus={isEdit}
            />
          </Field>
          <Field
            id={partOfId}
            label="Part of"
            hint="A part is allowed only while what it is part of is."
          >
            <Input
              id={partOfId}
              value={partOf}
              onChange={(event) => setPartOf(event.target.value)}
              onKeyDown={onEnter}
              placeholder="none"
              list={`${partOfId}-options`}
            />
            <datalist id={`${partOfId}-options`}>
              {partOfOptions
                .filter((name) => name !== trimmedName)
                .map((name) => (
                  <option key={name} value={name} />
                ))}
            </datalist>
          </Field>
          <Field id={descriptionId} label="Why">
            <Input
              id={descriptionId}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={onEnter}
              placeholder="GitHub CLI for PR work"
              maxLength={500}
            />
          </Field>
          <Field
            id={settingId}
            label="Setting"
            hint="Ensure installed makes Cloudable install it when it is missing. Ensure latest version also updates it. Both need an approval first."
          >
            <PackageSettingSelect
              id={settingId}
              value={setting}
              onChange={setSetting}
              packageName={trimmedName}
              versionPin={trimmedVersion === "" ? null : trimmedVersion}
              className="h-10 w-full"
            />
          </Field>
          {scope !== "machine" && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={lockedId}
                  checked={locked}
                  onCheckedChange={(checked) => setLocked(checked === true)}
                />
                <Label htmlFor={lockedId} className="text-sm font-normal">
                  Locked
                </Label>
              </div>
              <span className="text-xs text-muted-foreground">
                {scope === "org"
                  ? "A profile or machine cannot override or exclude a locked package."
                  : "A machine on this profile cannot override or exclude a locked package."}
              </span>
            </div>
          )}
          {isDuplicate && (
            <p className="text-xs text-destructive">
              "{trimmedName}" is already{" "}
              {scope === "org"
                ? "on the org list"
                : scope === "profile"
                  ? "on this profile"
                  : "on this machine"}
              . Use Edit in its row instead.
            </p>
          )}
          {settingProblem && trimmedName !== "" && (
            <p className="text-xs text-destructive">
              {PACKAGE_SETTING_LABELS[setting]} is not possible here: {settingProblem}.
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {saveMutation.isPending ? "Saving…" : isEdit ? "Save" : "Add package"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
