import { rmSync, writeFileSync } from "node:fs";
import { MACHINE_OS_USER, isValidPackageName } from "@cloudable/contracts";
import type { PackageActionResult, PendingPackageAction } from "@cloudable/contracts";
import type { UserManager } from "./global-tools";
import { type CommandRunner, bunCommandRunner } from "./installed-packages";
import {
  type UserActionContext,
  applyUserPackageAction,
  availableUserVersion,
  userManagerOf,
} from "./user-package-actions";

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
 * - It runs as root, because the systemd unit has no `User=`. apt runs as root;
 *   npm, pipx, cargo and Nix run as the machine user (`user-package-actions.ts`).
 *   Nothing here builds a shell string. Every call is an argv array through `Bun.spawn`, and
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
 * The apt package that brings Nix to Ubuntu (24.04 ships Nix 2.18). Installing it
 * is not quite enough on its own, so the same action does two more things, and
 * undoes them on uninstall:
 *
 * - The daemon's socket folder is `root:nix-users`, mode 770, so the machine user
 *   cannot use Nix until it is in `nix-users`.
 * - The package adds no shell hook, so nothing a person installs with Nix would be
 *   on their PATH. A one-line file in `/etc/profile.d` adds `~/.nix-profile/bin`.
 *
 * Both are part of the one approved, recorded action a person asked for, and the
 * action result says they happened.
 */
export const NIX_SETUP_PACKAGE = "nix-setup-systemd";
export const NIX_PROFILE_HOOK = "/etc/profile.d/cloudable-nix.sh";
const NIX_PROFILE_HOOK_CONTENT = `# Written by Cloudable when ${NIX_SETUP_PACKAGE} was installed. Removed with it.
if [ -d "$HOME/.nix-profile/bin" ]; then PATH="$HOME/.nix-profile/bin:$PATH"; fi
`;

export interface FileWriter {
  write(path: string, content: string): void;
  remove(path: string): void;
}

const realFiles: FileWriter = {
  write: (path, content) => writeFileSync(path, content, { mode: 0o644 }),
  remove: (path) => rmSync(path, { force: true }),
};

async function nixSetup(
  op: PendingPackageAction["op"],
  runner: CommandRunner,
  files: FileWriter,
  user: string,
): Promise<string> {
  if (op === "install") {
    const added = await runner.run("usermod", ["-aG", "nix-users", user]);
    files.write(NIX_PROFILE_HOOK, NIX_PROFILE_HOOK_CONTENT);
    return added?.exitCode === 0
      ? `added ${user} to nix-users; wrote ${NIX_PROFILE_HOOK}`
      : `could not add ${user} to nix-users (${tail(added?.stderr ?? "") || "usermod failed"}); wrote ${NIX_PROFILE_HOOK}`;
  }
  // The group may already be gone with the package. Either way the user is out of it.
  await runner.run("gpasswd", ["-d", user, "nix-users"]);
  files.remove(NIX_PROFILE_HOOK);
  return `removed ${user} from nix-users; removed ${NIX_PROFILE_HOOK}`;
}

export interface ApplyOptions {
  readonly user?: string;
  readonly files?: FileWriter;
  readonly cargoAuditableAvailable?: () => boolean;
}

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
  options: ApplyOptions = {},
): Promise<PackageActionResult> {
  const userManager = userManagerOf(action.packageName);
  if (userManager) {
    try {
      const context: UserActionContext = {
        runner,
        ...(options.user ? { user: options.user } : {}),
        ...(options.cargoAuditableAvailable
          ? { cargoAuditableAvailable: options.cargoAuditableAvailable }
          : {}),
      };
      return await applyUserPackageAction(action, userManager.manager, userManager.name, context);
    } catch (error) {
      return {
        id: action.id,
        outcome: "failed",
        detail: tail(error instanceof Error ? error.message : String(error)),
      };
    }
  }

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

    const setupNote =
      action.packageName === NIX_SETUP_PACKAGE
        ? await nixSetup(
            action.op,
            runner,
            options.files ?? realFiles,
            options.user ?? MACHINE_OS_USER,
          )
        : null;
    const note = setupNote ? { detail: setupNote } : {};

    if (action.op === "uninstall") {
      return { id: action.id, outcome: "succeeded", ...note };
    }

    // Report what actually landed, not what was asked for. Asking for a pin
    // and getting something else is a mismatch the console flags, and it can
    // only do that if the real version comes back.
    const installedVersion = await installedVersionOf(runner, pm, action.packageName);
    return {
      id: action.id,
      outcome: "succeeded",
      ...note,
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
  options: ApplyOptions = {},
): Promise<PackageActionResult[]> {
  const results: PackageActionResult[] = [];
  for (const action of actions) {
    results.push(await applyPackageAction(action, runner, options));
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

/**
 * Installed versions of the allowed npm, pipx, cargo and Nix packages, taken from
 * the inventory the agent already gathered (`global-tools.ts`), so nothing runs twice.
 */
export function userPackageVersions(
  allowedPackages: readonly string[],
  installed: ReadonlyMap<string, string | undefined>,
): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const name of allowedPackages) {
    if (!userManagerOf(name)) continue;
    const version = installed.get(name);
    if (version) versions[name] = version;
  }
  return versions;
}

/**
 * The newest version each registry offers for the allowed npm, pipx, cargo and
 * Nix packages, for *Ensure latest version*. Unlike apt there is no local list to
 * read, so each one is a network request. They are made at most once an hour and
 * in the background: a poll reports whatever the last round found and never
 * waits for the registries.
 */
export function cachedAvailableUserVersions(
  intervalMs = 60 * 60 * 1000,
  lookup: (
    manager: UserManager,
    name: string,
    nixSnapshot: string | undefined,
  ) => Promise<string | undefined> = (manager, name, nixSnapshot) =>
    availableUserVersion(bunCommandRunner, manager, name, nixSnapshot ? { nixSnapshot } : {}),
  now: () => number = Date.now,
) {
  let versions: Record<string, string> = {};
  let lastKey = "";
  let lastAt = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | null = null;

  const refresh = async (names: readonly string[], nixSnapshot: string | undefined) => {
    const next: Record<string, string> = {};
    for (const declared of names) {
      const parsed = userManagerOf(declared);
      if (!parsed) continue;
      const version = await lookup(parsed.manager, parsed.name, nixSnapshot).catch(() => undefined);
      if (version) next[declared] = version;
    }
    versions = next;
  };

  const current = (
    allowedPackages: readonly string[],
    nixSnapshot?: string,
  ): Record<string, string> => {
    const names = allowedPackages.filter((name) => userManagerOf(name) !== null).sort();
    // A changed allow list or snapshot is worth asking again now, not in an hour.
    const key = `${nixSnapshot ?? ""}|${names.join(",")}`;
    if (!running && (key !== lastKey || now() - lastAt >= intervalMs)) {
      lastKey = key;
      lastAt = now();
      running = refresh(names, nixSnapshot).finally(() => {
        running = null;
      });
    }
    return versions;
  };
  /** For tests: resolves when the refresh in flight, if any, is done. */
  current.settled = () => running ?? Promise.resolve();
  return current;
}
