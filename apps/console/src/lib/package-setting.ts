import {
  PACKAGE_SETTINGS,
  type PackageEnsureApprovalView,
  type PackageSetting,
  isInstallablePackageName,
} from "@cloudable/contracts";

/**
 * What Cloudable does about a declared package: only allow it, or install it
 * when missing, or also keep it on the newest version. See `PackageSetting` in
 * the contracts package. Shared by the machine packages table, the machine's
 * add form, and the org package card.
 */
export { PACKAGE_SETTINGS, type PackageSetting };

export const PACKAGE_SETTING_LABELS: Record<PackageSetting, string> = {
  allowed: "Allowed",
  ensure_installed: "Ensure installed",
  ensure_latest: "Ensure latest version",
};

/**
 * Why a setting cannot be picked for this entry, or null when it can. Mirrors
 * the control plane's own check, so the select never offers what the server
 * would refuse.
 */
export function settingUnavailableReason(
  setting: PackageSetting,
  entry: { packageName: string; versionPin: string | null },
): string | null {
  if (setting === "allowed") return null;
  if (!isInstallablePackageName(entry.packageName)) return "Cloudable cannot install this kind";
  if (setting === "ensure_latest" && entry.versionPin) return "not with a version pin";
  return null;
}

export interface SettingChangeOutcome {
  kind: "success" | "error";
  title: string;
  description?: string;
}

/**
 * What to tell the person after a setting change. Moving to an ensure setting
 * waits for an approval unless the org needs none, in which case the response
 * says it is already approved. Moving back to Allowed applies at once.
 */
export function describeSettingChange(
  packageName: string,
  setting: PackageSetting,
  ensureApprovals: readonly PackageEnsureApprovalView[] | undefined,
): SettingChangeOutcome {
  const label = PACKAGE_SETTING_LABELS[setting];
  const approval = ensureApprovals?.find((candidate) => candidate.packageName === packageName);
  if (setting === "allowed" || !approval || approval.status === "approved") {
    return { kind: "success", title: `"${packageName}" set to ${label}` };
  }
  if (approval.status === "pending") {
    return {
      kind: "success",
      title: `Asked to set "${packageName}" to ${label}`,
      description: "Waiting for approval. It applies once an approver says yes.",
    };
  }
  return {
    kind: "error",
    title: `"${packageName}" was not set to ${label}`,
    description: `The approval was ${approval.status}.`,
  };
}

/** "in 5h", "in 2d", or "soon" when the time has come or is under a minute away. */
export function formatNextTry(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((at - now) / 1000);
  if (seconds < 60) return "soon";
  const units: Array<[string, number]> = [
    ["d", 60 * 60 * 24],
    ["h", 60 * 60],
    ["m", 60],
  ];
  for (const [label, size] of units) {
    if (seconds >= size) return `in ${Math.floor(seconds / size)}${label}`;
  }
  return "soon";
}
