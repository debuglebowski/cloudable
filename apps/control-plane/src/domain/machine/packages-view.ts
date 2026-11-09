import type {
  MachinePackageRow,
  PackageInstallState,
  PackagePermission,
  PendingPackageActionView,
} from "@cloudable/contracts";
import { type ResolvedManifestEntry, allowedPackageNames } from "./manifest";

/**
 * Builds a machine's packages table: one row per package across the union of
 * what the manifest declares and what the agent reported.
 *
 * Pure, and deliberately so — the join is the part worth testing, and it has
 * no business touching a database to be tested. See `packages-view.test.ts`.
 *
 * The two halves answer different questions and are kept apart everywhere:
 * the manifest says what is *allowed*, the report says what is *there*. A row
 * can be allowed and absent, or present and disallowed, and both are ordinary
 * states rather than errors.
 */

export interface PackagesViewInput {
  /** Resolved org -> machine manifest, including excluded entries. */
  manifest: ReadonlyArray<ResolvedManifestEntry>;
  /**
   * Package names from the agent's last report, or null when it has never
   * reported. Null and empty mean different things: null is "we have not been
   * told", empty is "the machine says nothing is installed".
   */
  installedPackages: ReadonlyArray<string> | null;
  /** Versions for declared packages only — see `AgentReportRequest`. */
  declaredPackageVersions?: Readonly<Record<string, string>> | undefined;
  /** What the image shipped with. Null before the first report. */
  baselinePackages: ReadonlyArray<string> | null;
  /**
   * What someone installed on purpose; everything else installed came in as a
   * dependency. Null or absent when the agent did not say, and then no row is
   * treated as a dependency.
   */
  manuallyInstalledPackages?: ReadonlyArray<string> | null | undefined;
  /** Outstanding actions by package name. */
  pendingActions?: ReadonlyMap<string, PendingPackageActionView> | undefined;
}

/**
 * A part whose parent is not allowed has no permission of its own: it reads
 * exactly like a package nobody declared, which is what it now is.
 */
const permissionOf = (
  entry: ResolvedManifestEntry | undefined,
  allowed: ReadonlySet<string>,
): PackagePermission => {
  if (!entry) return null;
  if (entry.excluded) return "disallowed";
  return allowed.has(entry.packageName) ? "allowed" : null;
};

/** apt is the only manager that records whether a package was installed as a dependency. */
const isAptName = (packageName: string): boolean => !packageName.includes(":");

export function buildPackagesView(input: PackagesViewInput): MachinePackageRow[] {
  const { manifest, installedPackages, baselinePackages, declaredPackageVersions } = input;

  const declaredByName = new Map(manifest.map((entry) => [entry.packageName, entry]));
  const allowed = allowedPackageNames(manifest);
  const installedSet = installedPackages === null ? null : new Set(installedPackages);
  const baselineSet = new Set(baselinePackages ?? []);
  const manualSet =
    input.manuallyInstalledPackages == null ? null : new Set(input.manuallyInstalledPackages);
  const pendingActions = input.pendingActions ?? new Map<string, PendingPackageActionView>();

  const names = new Set<string>([
    ...declaredByName.keys(),
    ...(installedPackages ?? []),
    // A package with an action outstanding must appear even when it is neither
    // declared nor installed yet — otherwise pressing Install on an undeclared
    // package makes the row vanish until the agent reports back.
    ...pendingActions.keys(),
  ]);

  const rows: MachinePackageRow[] = [];
  for (const packageName of names) {
    const entry = declaredByName.get(packageName);
    const installed: PackageInstallState =
      installedSet === null
        ? "unknown"
        : installedSet.has(packageName)
          ? "installed"
          : "not_installed";

    const installedVersion = declaredPackageVersions?.[packageName];
    // Only a pinned, installed package whose version we actually know can
    // mismatch. Absent version information is not evidence of a mismatch.
    const versionMismatch =
      installed === "installed" &&
      entry?.versionPin != null &&
      installedVersion !== undefined &&
      installedVersion !== entry.versionPin;

    const pendingAction = pendingActions.get(packageName);

    rows.push({
      packageName,
      permission: permissionOf(entry, allowed),
      versionPin: entry?.versionPin ?? null,
      source: entry?.source ?? null,
      installed,
      ...(installedVersion !== undefined ? { installedVersion } : {}),
      versionMismatch,
      isBaseline: baselineSet.has(packageName),
      partOf: entry?.partOf ?? null,
      installedAsDependency:
        manualSet !== null &&
        installed === "installed" &&
        isAptName(packageName) &&
        !manualSet.has(packageName),
      ...(pendingAction ? { pendingAction } : {}),
    });
  }

  // Interesting first: anything a person needs to look at sorts above the
  // rows that are simply fine, and the base image sinks to the bottom.
  return rows.sort((a, b) => rank(a) - rank(b) || a.packageName.localeCompare(b.packageName));
}

/** Lower sorts first. */
function rank(row: MachinePackageRow): number {
  if (row.pendingAction) return 0;
  if (row.permission === "disallowed" && row.installed === "installed") return 1;
  if (row.versionMismatch) return 2;
  if (row.permission === null && !row.isBaseline && !row.installedAsDependency) return 3;
  if (row.permission === "allowed") return 4;
  return row.isBaseline ? 6 : 5;
}

/**
 * Packages installed on the machine that nothing allows and that did not come
 * with the image — the "no undeclared software" set.
 *
 * Subtracting the baseline is what makes this usable. Without it every package
 * the image shipped with reads as undeclared software installed by nobody,
 * which is several hundred findings per machine and no signal at all.
 *
 * Dependencies are subtracted for the same reason. The package someone asked
 * for is what gets judged; what apt pulled in to satisfy it follows from that.
 * An undeclared package still reads as undeclared, and so does anything named
 * explicitly on an install command line, since apt marks those manual.
 */
export function undeclaredFromView(rows: ReadonlyArray<MachinePackageRow>): string[] {
  return rows
    .filter(
      (row) =>
        row.installed === "installed" &&
        !row.isBaseline &&
        !row.installedAsDependency &&
        row.permission !== "allowed",
    )
    .map((row) => row.packageName);
}
