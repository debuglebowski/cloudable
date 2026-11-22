import { type PackageActionTrigger, isInstallablePackageName } from "@cloudable/contracts";
import { type ResolvedManifestEntry, declaredPackages } from "./manifest";

/**
 * Which *Ensure* packages a machine needs an install for, decided from what its
 * agent just reported. Pure: the caller gathers the inputs and queues the
 * results (`MachineService.ensurePackages`).
 *
 * This is the one place Cloudable changes a machine without a person asking at
 * that moment. It is allowed to because an admin set the package to *Ensure*
 * and someone approved it (CLAUDE.md invariants 4, 5 and 10), and it does only
 * what that setting covers:
 *
 * - *Ensure installed*: install the package when it is missing. Never update it.
 * - *Ensure latest version*: also install the repository's newer version when
 *   the installed one is behind.
 *
 * It never removes anything, and never touches a package that is only *Allowed*.
 */

export type EnsureTrigger = Exclude<PackageActionTrigger, "person">;

export interface EnsureDecision {
  packageName: string;
  trigger: EnsureTrigger;
  /** The manifest's pin, for an *Ensure installed* entry that has one. */
  versionPin: string | null;
  /** `missing`: not installed at all. `outdated`: installed, but the repository has a newer version. */
  reason: "missing" | "outdated";
  installedVersion: string | null;
  availableVersion: string | null;
}

/** The latest finished ensure action for one package on this machine. */
export interface LastEnsureAction {
  status: "succeeded" | "failed" | "expired";
  trigger: EnsureTrigger;
  finishedAt: Date;
}

export interface EnsureInput {
  manifest: ReadonlyArray<ResolvedManifestEntry>;
  /** The agent's inventory. Null when it has never reported: then nothing is decided. */
  installedPackages: ReadonlyArray<string> | null;
  /** Installed versions of the allowed packages, as reported. */
  installedVersions: Readonly<Record<string, string>>;
  /** What the repository offers for the allowed packages. Empty from an agent too old to say. */
  availableVersions: Readonly<Record<string, string>>;
  /** What the machine's image shipped with. Cloudable never installs or removes those. */
  baselinePackages: ReadonlySet<string>;
  /** Packages with an action already waiting or running. One at a time per package. */
  outstanding: ReadonlySet<string>;
  lastEnsureActions: ReadonlyMap<string, LastEnsureAction>;
  /** The org's wait after a failed try (`packages.ensureRetryHours`), in milliseconds. */
  retryWaitMs: number;
  now: Date;
}

/**
 * After an ensure action finishes, the next report or two can still describe
 * the machine from before it (a report already in flight). Waiting this long
 * before deciding again about the same package keeps one change from being
 * queued twice.
 */
export const SETTLE_MS = 5 * 60 * 1000;

/** When an ensure install that failed may be tried again; null when nothing is holding it back. */
export const nextEnsureAttemptAt = (
  last: LastEnsureAction | undefined,
  retryWaitMs: number,
): Date | null =>
  last && last.status !== "succeeded" ? new Date(last.finishedAt.getTime() + retryWaitMs) : null;

export function decideEnsureActions(input: EnsureInput): EnsureDecision[] {
  if (input.installedPackages === null) return [];
  const installed = new Set(input.installedPackages);
  const decisions: EnsureDecision[] = [];

  // Through `declaredPackages`: an excluded entry, or a part whose parent is not allowed,
  // is not allowed on this machine at all, let alone ensured.
  for (const entry of declaredPackages(input.manifest)) {
    if (entry.setting === "allowed") continue;
    const name = entry.packageName;
    if (!isInstallablePackageName(name)) continue;
    if (input.baselinePackages.has(name) || input.outstanding.has(name)) continue;

    const last = input.lastEnsureActions.get(name);
    const sinceLast = last
      ? input.now.getTime() - last.finishedAt.getTime()
      : Number.POSITIVE_INFINITY;
    if (sinceLast < SETTLE_MS) continue;
    const retryAt = nextEnsureAttemptAt(last, input.retryWaitMs);
    if (retryAt && input.now < retryAt) continue;

    const installedVersion = input.installedVersions[name] ?? null;
    const availableVersion = input.availableVersions[name] ?? null;

    if (!installed.has(name)) {
      decisions.push({
        packageName: name,
        trigger: entry.setting,
        versionPin: entry.setting === "ensure_installed" ? entry.versionPin : null,
        reason: "missing",
        installedVersion: null,
        availableVersion,
      });
      continue;
    }

    if (
      entry.setting === "ensure_latest" &&
      installedVersion !== null &&
      availableVersion !== null &&
      installedVersion !== availableVersion
    ) {
      // An update that succeeded and still left the package behind (a held package, a
      // pinned apt preference) would otherwise be queued again every few minutes. Wait the
      // org's retry time instead, the same as after a failure.
      if (
        last?.status === "succeeded" &&
        last.trigger === "ensure_latest" &&
        sinceLast < input.retryWaitMs
      ) {
        continue;
      }
      decisions.push({
        packageName: name,
        trigger: "ensure_latest",
        versionPin: null,
        reason: "outdated",
        installedVersion,
        availableVersion,
      });
    }
  }
  return decisions;
}
