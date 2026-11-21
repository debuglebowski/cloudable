import { isValidPackageName } from "@cloudable/contracts";
import type { PackageActionResult, PendingPackageAction } from "@cloudable/contracts";
import { type CommandRunner, bunCommandRunner } from "./installed-packages";

/**
 * The agent's only ability to change the machine it runs on.
 *
 * Everything else in this binary observes: `installed-packages.ts` asks dpkg
 * what is there, `open-ports.ts` reads /proc, `access-methods.ts` reads
 * /proc. This module installs and removes software, which makes it worth
 * being precise about the boundaries:
 *
 * - It never decides anything. It performs actions the control plane handed it,
 *   each asked for by a person or required by a package's approved *Ensure*
 *   setting, which the control plane decides. There is no local
 *   reconciliation, no "install everything in the manifest", no cleanup of
 *   undeclared packages. Keeping every decision in the control plane is what
 *   keeps each change recorded with the person or setting behind it
 *   (invariants 4, 5 and 10).
 * - It never reports events, only outcomes. What those outcomes mean is the
 *   control plane's to decide and record (invariant 12).
 * - It runs as root, because the systemd unit has no `User=`. So nothing here
 *   builds a shell string. Every call is an argv array through `Bun.spawn`, and
 *   the package name is re-validated here even though the control plane
 *   validated it twice already — this is the last line before the exec, and it
 *   is the one that matters if the others are ever refactored away.
 */

interface PackageManagerOps {
  readonly binary: string;
  /** Refresh package lists. Skipped when the manager does not need it. */
  readonly refresh?: readonly string[];
  readonly install: (name: string, versionPin: string | null) => readonly string[];
  readonly remove: (name: string) => readonly string[];
  /** Prints the installed version of one package, or exits non-zero. */
  readonly queryVersion: (name: string) => readonly string[];
}

const APT: PackageManagerOps = {
  binary: "apt-get",
  refresh: ["update"],
  // `name=version` is apt's own pin syntax. An unavailable version fails
  // loudly here rather than silently installing something else.
  install: (name, versionPin) => [
    "install",
    "-y",
    "--no-install-recommends",
    versionPin ? `${name}=${versionPin}` : name,
  ],
  // `remove`, never `purge`: configuration and data a person put on the machine
  // is not ours to delete because a package was uninstalled.
  remove: (name) => ["remove", "-y", name],
  queryVersion: (name) => ["-W", "-f=${Version}", name],
};

const DNF: PackageManagerOps = {
  binary: "dnf",
  install: (name, versionPin) => ["install", "-y", versionPin ? `${name}-${versionPin}` : name],
  remove: (name) => ["remove", "-y", name],
  queryVersion: (name) => ["-q", "--qf", "%{VERSION}", name],
};

/** dpkg-query, not apt-get, answers the version question on Debian. */
const APT_VERSION_BINARY = "dpkg-query";
const DNF_VERSION_BINARY = "rpm";

const PACKAGE_MANAGERS: readonly PackageManagerOps[] = [APT, DNF];

/**
 * Finds the package manager actually present, rather than assuming a distro.
 * Same approach as `installed-packages.ts`, and the same honest failure: none
 * present returns null, and the caller reports that as a failed action instead
 * of crashing the poll loop over something orthogonal to it.
 */
async function detectManager(runner: CommandRunner): Promise<PackageManagerOps | null> {
  for (const pm of PACKAGE_MANAGERS) {
    // `--version` on a present binary exits 0; an absent one gives us null.
    const probe = await runner.run(pm.binary, ["--version"]);
    if (probe !== null) return pm;
  }
  return null;
}

async function installedVersionOf(
  runner: CommandRunner,
  pm: PackageManagerOps,
  packageName: string,
): Promise<string | undefined> {
  const binary = pm === APT ? APT_VERSION_BINARY : DNF_VERSION_BINARY;
  const result = await runner.run(binary, pm.queryVersion(packageName));
  if (result === null || result.exitCode !== 0) return undefined;
  const version = result.stdout.trim();
  return version === "" ? undefined : version;
}

/** Keeps a failure message useful without shipping a megabyte of apt output. */
const MAX_DETAIL_LENGTH = 400;

const tail = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= MAX_DETAIL_LENGTH
    ? trimmed
    : `...${trimmed.slice(trimmed.length - MAX_DETAIL_LENGTH)}`;
};

/**
 * Performs one action and describes what happened.
 *
 * Never throws: a rejected action is a result to report, not a reason to break
 * the poll/report loop. An action that throws its way out of here would leave
 * the control plane waiting for a result that never comes, which is exactly
 * the case expiry exists to catch — but expiring is a worse outcome than
 * simply saying "this failed, here is why".
 */
export async function applyPackageAction(
  action: PendingPackageAction,
  runner: CommandRunner = bunCommandRunner,
): Promise<PackageActionResult> {
  if (!isValidPackageName(action.packageName)) {
    return { id: action.id, outcome: "failed", detail: "rejected an invalid package name" };
  }

  try {
    // Inside the try, not before it: a runner that throws on the very first
    // probe must still produce a result. An action that escapes as an
    // exception leaves the control plane waiting for an outcome that never
    // comes, which is exactly what expiry has to clean up afterwards.
    const pm = await detectManager(runner);
    if (pm === null) {
      return {
        id: action.id,
        outcome: "failed",
        detail: "no supported package manager found on this machine",
      };
    }

    if (action.op === "install" && pm.refresh) {
      // A stale package list is the most common cause of "unable to locate
      // package" on a machine that has been up for a while. A refresh failure
      // is not itself fatal — the install below may still succeed from cache,
      // and if it does not, its own error is the more useful one to report.
      await runner.run(pm.binary, pm.refresh);
    }

    const args =
      action.op === "install"
        ? pm.install(action.packageName, action.versionPin)
        : pm.remove(action.packageName);

    const result = await runner.run(pm.binary, args);
    if (result === null) {
      return { id: action.id, outcome: "failed", detail: `could not run ${pm.binary}` };
    }
    if (result.exitCode !== 0) {
      return {
        id: action.id,
        outcome: "failed",
        detail: tail(result.stderr ?? result.stdout) || `${pm.binary} exited ${result.exitCode}`,
      };
    }

    if (action.op === "uninstall") {
      return { id: action.id, outcome: "succeeded" };
    }

    // Report what actually landed, not what was asked for. Asking for a pin
    // and getting something else is a mismatch the console flags, and it can
    // only do that if the real version comes back.
    const installedVersion = await installedVersionOf(runner, pm, action.packageName);
    return {
      id: action.id,
      outcome: "succeeded",
      ...(installedVersion !== undefined ? { installedVersion } : {}),
    };
  } catch (error) {
    return {
      id: action.id,
      outcome: "failed",
      detail: tail(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Runs the actions from one poll, in order and one at a time.
 *
 * Sequential on purpose: two `apt-get` processes on one machine collide on the
 * dpkg lock, and the second fails with a lock error that has nothing to do
 * with the package it was asked about.
 */
export async function applyPackageActions(
  actions: readonly PendingPackageAction[],
  runner: CommandRunner = bunCommandRunner,
): Promise<PackageActionResult[]> {
  const results: PackageActionResult[] = [];
  for (const action of actions) {
    results.push(await applyPackageAction(action, runner));
  }
  return results;
}

/**
 * Versions of the packages this machine is allowed to have.
 *
 * Only the allowed set, not the whole inventory: versions exist to check pins,
 * pins only live on declared entries, and sending ~600 versions every 30
 * seconds to answer a question about a handful would be waste.
 */
export async function declaredPackageVersions(
  allowedPackages: readonly string[],
  runner: CommandRunner = bunCommandRunner,
): Promise<Record<string, string>> {
  if (allowedPackages.length === 0) return {};
  const pm = await detectManager(runner);
  if (pm === null) return {};

  const versions: Record<string, string> = {};
  for (const name of allowedPackages) {
    if (!isValidPackageName(name)) continue;
    const version = await installedVersionOf(runner, pm, name);
    if (version !== undefined) versions[name] = version;
  }
  return versions;
}

/**
 * The newest version the package repository offers for each allowed apt
 * package (apt's "Candidate"), so the control plane can tell whether an
 * *Ensure latest version* package is behind.
 *
 * Reads the package lists the OS already keeps (Ubuntu refreshes them daily).
 * It never runs `apt-get update` itself: this runs every poll, and fetching
 * the lists that often would be a load on the mirrors for nothing. One
 * `apt-cache policy` call covers every name. A candidate equal to the
 * installed version means up to date; apt never offers a downgrade as the
 * candidate.
 */
export async function availablePackageVersions(
  allowedPackages: readonly string[],
  runner: CommandRunner = bunCommandRunner,
): Promise<Record<string, string>> {
  // Bare names only: a colon means another manager, which apt knows nothing about.
  const names = allowedPackages.filter((name) => isValidPackageName(name));
  if (names.length === 0) return {};
  const pm = await detectManager(runner);
  if (pm !== APT) return {};
  const result = await runner.run("apt-cache", ["policy", ...names]);
  if (result === null || result.exitCode !== 0) return {};
  return parseAptCachePolicy(result.stdout);
}

/** Exported for the test. `(none)` means the repository has no version of it at all. */
export function parseAptCachePolicy(output: string): Record<string, string> {
  const versions: Record<string, string> = {};
  let current: string | null = null;
  for (const line of output.split("\n")) {
    const header = /^(\S+):$/.exec(line);
    if (header?.[1]) {
      // apt-cache prints `name:arch` for a foreign-architecture package; the
      // manifest knows the bare name.
      current = header[1].split(":")[0] ?? null;
      continue;
    }
    const candidate = /^\s+Candidate:\s+(\S+)/.exec(line);
    if (current && candidate?.[1] && candidate[1] !== "(none)") {
      versions[current] = candidate[1];
    }
  }
  return versions;
}
