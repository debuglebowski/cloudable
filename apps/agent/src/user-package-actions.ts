import { existsSync } from "node:fs";
import {
  MACHINE_OS_USER,
  NIXPKGS_COMMIT_PATTERN,
  isValidVersionPin,
  parseDeclaredPackageName,
} from "@cloudable/contracts";
import type { PackageActionResult, PendingPackageAction } from "@cloudable/contracts";
import {
  NIX_FEATURES,
  type UserManager,
  parseCargoList,
  parseNixProfile,
  parseNpmGlobal,
  parsePipxList,
  runAsUser,
} from "./global-tools";
import type { CommandResult, CommandRunner } from "./installed-packages";

/**
 * Installs and removes npm, pipx, cargo and Nix packages, the counterpart of the
 * apt code in `apply-packages.ts`. The same boundaries hold: it performs actions
 * the control plane handed it and decides nothing itself.
 *
 * The difference from apt is who runs the manager. apt is the system's, so it
 * runs as root. These four install into the machine user's own folders
 * (`~/.local`, `~/.cargo`, `~/.nix-profile`), so they run as that user. That is
 * where the inventory (`global-tools.ts`) looks, and it keeps package install
 * scripts, which npm, pip and cargo all run, from running as root.
 *
 * A missing manager fails the action with a plain message. Cloudable never
 * installs the manager on its own: a person asks for `npm`, `pipx`, `cargo` or
 * `nix-setup-systemd` through apt first.
 */

/**
 * How long one install may take before `timeout` stops it. Cargo compiles from
 * source, so it gets the most. The control plane's expiry for each manager
 * (`actionExpiryMs` in `package-actions.ts`) is longer than these.
 */
export const INSTALL_TIMEOUT_SECONDS: Record<UserManager, number> = {
  npm: 10 * 60,
  pipx: 10 * 60,
  cargo: 30 * 60,
  nix: 15 * 60,
};

/** Nix 2.18 is what Ubuntu 24.04 ships, and the oldest whose `profile list --json` we read. */
const MIN_NIX_VERSION: readonly [number, number] = [2, 18];

/**
 * Where Cloudable's copy of cargo-auditable lives once the scanner component put
 * it there (`docs/agents.md`). When present, cargo installs go through it, so
 * the vulnerability scan can read which crates a binary was built from.
 */
export const CARGO_AUDITABLE_PATH = "/opt/cloudable/cargo-auditable";

export interface UserActionContext {
  readonly runner: CommandRunner;
  readonly user?: string;
  /** Overridable for tests; defaults to checking the real file. */
  readonly cargoAuditableAvailable?: () => boolean;
}

const MAX_DETAIL_LENGTH = 400;

/**
 * What an interactive bash with no terminal prints before anything else. It is noise from
 * `runAsUser`'s shell, not the manager's answer, so it never reaches an action's message.
 */
const BASH_NO_TTY_NOISE =
  /^bash: (cannot set terminal process group|no job control in this shell).*$/gm;

export const tail = (text: string): string => {
  const trimmed = text.replace(BASH_NO_TTY_NOISE, "").trim();
  return trimmed.length <= MAX_DETAIL_LENGTH
    ? trimmed
    : `...${trimmed.slice(trimmed.length - MAX_DETAIL_LENGTH)}`;
};

const nixFlakeRef = (commit: string, attr: string) => `github:NixOS/nixpkgs/${commit}#${attr}`;

/** Turns a finished command into a failure message, or null when it succeeded. */
function failureOf(result: CommandResult | null, manager: string, user: string): string | null {
  if (result === null) return "could not run runuser";
  if (result.exitCode === 0) return null;
  if (result.exitCode === 127) return `${manager} is not installed for user ${user}`;
  if (result.exitCode === 124) return `${manager} took too long and was stopped`;
  return tail(result.stderr ?? result.stdout) || `${manager} exited ${result.exitCode}`;
}

async function nixVersionProblem(
  ctx: Required<Omit<UserActionContext, "cargoAuditableAvailable">>,
) {
  const result = await runAsUser(ctx.runner, ["nix", "--version"], 20, ctx.user);
  const failure = failureOf(result, "nix", ctx.user);
  if (failure) return failure;
  const match = /(\d+)\.(\d+)/.exec(result?.stdout ?? "");
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (
    !match ||
    major < MIN_NIX_VERSION[0] ||
    (major === MIN_NIX_VERSION[0] && minor < MIN_NIX_VERSION[1])
  ) {
    return `Nix ${MIN_NIX_VERSION.join(".")} or newer is needed (Ubuntu 24.04); this machine has ${result?.stdout.trim() || "an unknown version"}`;
  }
  return null;
}

async function nixProfile(runner: CommandRunner, user: string) {
  const result = await runAsUser(
    runner,
    ["nix", ...NIX_FEATURES, "profile", "list", "--json"],
    60,
    user,
  );
  return result?.exitCode === 0 ? parseNixProfile(result.stdout) : [];
}

/**
 * Ubuntu's npm installs global packages into `/usr/local`, which the machine user
 * cannot write. Running npm as root instead would run every package's install
 * scripts as root. So before the first install, if the user's global folder is
 * not writable, point it at `~/.local` in the user's own `~/.npmrc`. Ubuntu's
 * `~/.profile` already puts `~/.local/bin` on PATH. Returns a note for the action
 * result when it changed something.
 */
async function ensureWritableNpmPrefix(
  runner: CommandRunner,
  user: string,
): Promise<string | null> {
  const prefix = await runAsUser(runner, ["npm", "prefix", "-g"], 30, user);
  if (prefix === null || prefix.exitCode !== 0) return null;
  const path = prefix.stdout.trim();
  const writable = await runAsUser(runner, ["test", "-w", path], 10, user);
  if (writable?.exitCode === 0) return null;
  // A constant script: `$HOME` is the only thing expanded, and it is the user's own.
  const set = await runAsUser(
    runner,
    ["sh", "-c", 'npm config set --location=user prefix "$HOME/.local"'],
    30,
    user,
  );
  return set?.exitCode === 0
    ? `npm global folder moved from ${path} to ~/.local for ${user}`
    : null;
}

/** The installed version of one package, read the same way the inventory reads it. */
export async function installedUserVersion(
  runner: CommandRunner,
  manager: UserManager,
  name: string,
  user: string = MACHINE_OS_USER,
): Promise<string | undefined> {
  if (manager === "nix") {
    return (await nixProfile(runner, user)).find((element) => element.name === name)?.version;
  }
  const argv =
    manager === "npm"
      ? ["npm", "ls", "-g", "--depth=0", "--json"]
      : manager === "pipx"
        ? ["pipx", "list", "--json"]
        : ["cargo", "install", "--list"];
  const parse =
    manager === "npm" ? parseNpmGlobal : manager === "pipx" ? parsePipxList : parseCargoList;
  const result = await runAsUser(runner, argv, 30, user);
  if (result === null || result.stdout.trim().length === 0) return undefined;
  return parse(result.stdout).find((pkg) => pkg.name === name)?.version;
}

/**
 * Performs one install or uninstall for npm, pipx, cargo or nix. Never throws;
 * the caller (`applyPackageAction`) wraps it like the apt path.
 */
export async function applyUserPackageAction(
  action: PendingPackageAction,
  manager: UserManager,
  name: string,
  context: UserActionContext,
): Promise<PackageActionResult> {
  const runner = context.runner;
  const user = context.user ?? MACHINE_OS_USER;
  const failed = (detail: string): PackageActionResult => ({
    id: action.id,
    outcome: "failed",
    detail,
  });

  if (action.versionPin !== null && !isValidVersionPin(action.packageName, action.versionPin)) {
    return failed("rejected an invalid version pin");
  }

  const notes: string[] = [];
  let argv: readonly string[];

  switch (manager) {
    case "npm": {
      if (action.op === "install") {
        const note = await ensureWritableNpmPrefix(runner, user);
        if (note) notes.push(note);
        argv = ["npm", "install", "-g", action.versionPin ? `${name}@${action.versionPin}` : name];
      } else {
        argv = ["npm", "uninstall", "-g", name];
      }
      break;
    }
    case "pipx": {
      // `--force` so an install over an existing one (an *Ensure latest version*
      // update) replaces it, instead of pipx saying "already installed" and doing nothing.
      argv =
        action.op === "install"
          ? [
              "pipx",
              "install",
              "--force",
              action.versionPin ? `${name}==${action.versionPin}` : name,
            ]
          : ["pipx", "uninstall", name];
      break;
    }
    case "cargo": {
      if (action.op === "install") {
        const pin = action.versionPin ? ["--version", action.versionPin] : [];
        const auditable = (
          context.cargoAuditableAvailable ?? (() => existsSync(CARGO_AUDITABLE_PATH))
        )();
        // cargo-auditable is a cargo subcommand, so its binary takes `auditable` as
        // its first argument. It calls the user's own cargo for the build itself.
        argv = auditable
          ? [CARGO_AUDITABLE_PATH, "auditable", "install", "--locked", name, ...pin]
          : ["cargo", "install", "--locked", name, ...pin];
        if (!auditable) notes.push("installed without cargo-auditable, so it cannot be scanned");
      } else {
        argv = ["cargo", "uninstall", name];
      }
      break;
    }
    case "nix": {
      const versionProblem = await nixVersionProblem({ runner, user });
      if (versionProblem) return failed(versionProblem);
      const existing = (await nixProfile(runner, user)).find((element) => element.name === name);
      if (action.op === "uninstall") {
        if (!existing) return { id: action.id, outcome: "succeeded" };
        argv = ["nix", ...NIX_FEATURES, "profile", "remove", existing.handle];
        break;
      }
      const commit = action.nixpkgsCommit;
      if (!commit || !NIXPKGS_COMMIT_PATTERN.test(commit)) {
        return failed("no nixpkgs snapshot is set for this org (packages.nix.snapshot)");
      }
      // An installed element is locked to the commit it came from, so moving it to a
      // newer snapshot means removing it first. Otherwise Nix refuses the install as a
      // conflict with itself.
      if (existing) {
        const removed = await runAsUser(
          runner,
          ["nix", ...NIX_FEATURES, "profile", "remove", existing.handle],
          INSTALL_TIMEOUT_SECONDS.nix,
          user,
        );
        const failure = failureOf(removed, "nix", user);
        if (failure) return failed(failure);
      }
      argv = ["nix", ...NIX_FEATURES, "profile", "install", nixFlakeRef(commit, name)];
      break;
    }
  }

  const result = await runAsUser(runner, argv, INSTALL_TIMEOUT_SECONDS[manager], user);
  const failure = failureOf(result, manager, user);
  if (failure) return failed(failure);

  const detail = notes.length > 0 ? { detail: notes.join("; ") } : {};
  if (action.op === "uninstall") return { id: action.id, outcome: "succeeded", ...detail };

  // Report what actually landed, not what was asked for, as for apt.
  const installedVersion = await installedUserVersion(runner, manager, name, user);
  return {
    id: action.id,
    outcome: "succeeded",
    ...detail,
    ...(installedVersion !== undefined ? { installedVersion } : {}),
  };
}

/**
 * The newest version each manager's registry offers for one package, for
 * *Ensure latest version*. For Nix, "newest" means the version in the org's
 * snapshot: moving to newer Nix packages is moving the snapshot.
 */
export async function availableUserVersion(
  runner: CommandRunner,
  manager: UserManager,
  name: string,
  options: { user?: string; nixSnapshot?: string } = {},
): Promise<string | undefined> {
  const user = options.user ?? MACHINE_OS_USER;
  switch (manager) {
    case "npm": {
      const result = await runAsUser(runner, ["npm", "view", name, "version"], 30, user);
      const version = result?.exitCode === 0 ? result.stdout.trim() : "";
      return version || undefined;
    }
    case "pipx": {
      // pipx has no "what is the newest version" command, so ask PyPI directly.
      const result = await runAsUser(
        runner,
        [
          "curl",
          "-fsS",
          "--max-time",
          "20",
          `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
        ],
        30,
        user,
      );
      if (result?.exitCode !== 0) return undefined;
      try {
        const version = (JSON.parse(result.stdout) as { info?: { version?: unknown } }).info
          ?.version;
        return typeof version === "string" && version.length > 0 ? version : undefined;
      } catch {
        return undefined;
      }
    }
    case "cargo": {
      const result = await runAsUser(runner, ["cargo", "search", name, "--limit", "1"], 30, user);
      if (result?.exitCode !== 0) return undefined;
      return parseCargoSearch(result.stdout, name);
    }
    case "nix": {
      const snapshot = options.nixSnapshot;
      if (!snapshot || !NIXPKGS_COMMIT_PATTERN.test(snapshot)) return undefined;
      const result = await runAsUser(
        runner,
        ["nix", ...NIX_FEATURES, "eval", "--raw", `${nixFlakeRef(snapshot, name)}.version`],
        120,
        user,
      );
      const version = result?.exitCode === 0 ? result.stdout.trim() : "";
      return version || undefined;
    }
  }
}

/** `cargo search`: `ripgrep = "14.1.1"    # description`. Only an exact name match counts. */
export function parseCargoSearch(stdout: string, name: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const match = /^(\S+) = "([^"]+)"/.exec(line);
    if (match?.[1] === name) return match[2];
  }
  return undefined;
}

/** Splits an action's package name into a user-level manager and bare name, or null for apt. */
export function userManagerOf(packageName: string): { manager: UserManager; name: string } | null {
  const parsed = parseDeclaredPackageName(packageName);
  if (!parsed) return null;
  if (
    parsed.manager === "npm" ||
    parsed.manager === "pipx" ||
    parsed.manager === "cargo" ||
    parsed.manager === "nix"
  ) {
    return { manager: parsed.manager, name: parsed.name };
  }
  return null;
}
