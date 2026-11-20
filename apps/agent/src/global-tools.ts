import { MACHINE_OS_USER, isValidDeclaredPackageName } from "@cloudable/contracts";
import { type CommandResult, type CommandRunner, bunCommandRunner } from "./installed-packages";

/**
 * Packages from managers other than apt, reported as `<manager>:<name>`
 * (`npm:@openai/codex`, `pipx:black`, `cargo:ripgrep`, `nix:ripgrep`), so the
 * "no undeclared software" check can judge them the same way as apt packages.
 * See `PACKAGE_MANAGERS` in the contracts package for the naming rule.
 *
 * Only what each manager itself calls global: npm's global folder, pipx's
 * apps, `cargo install`ed crates, and the machine user's Nix profile. Project
 * dependencies (`node_modules`, a virtualenv) are not reported, and nothing
 * scans folders.
 *
 * Every command runs as the machine's own user, not as root: that user's tools
 * live under its own prefix (`~/.local`, `~/.nix-profile`), and asking as root
 * would answer for a different install. It runs through the user's own shell
 * setup so their PATH finds them. `timeout` bounds a slow or hanging manager.
 *
 * A manager that is absent or fails contributes nothing. That is the same as
 * having no global tools, which is the honest reading: nothing was found.
 */

export type UserManager = "npm" | "pipx" | "cargo" | "nix";

/**
 * Nix's flags on every call. Ubuntu's `nix-setup-systemd` leaves both features
 * off in `/etc/nix/nix.conf`, and Cloudable does not edit that file to turn them on.
 */
export const NIX_FEATURES = ["--extra-experimental-features", "nix-command flakes"] as const;

/**
 * Runs `argv` as `user` through a login, interactive bash, so the user's own PATH
 * (`~/.bashrc`, `~/.profile`) finds their tools.
 *
 * The command is passed as arguments to a constant script, never spliced into it,
 * so a package name cannot become shell syntax even if every validation above this
 * one were gone. Exit 127 means the first word is not installed for that user;
 * 124 is `timeout` giving up.
 */
const RUN_AS_USER_SCRIPT = 'command -v "$1" >/dev/null 2>&1 || exit 127; exec "$@"';

export function runAsUser(
  runner: CommandRunner,
  argv: readonly string[],
  timeoutSeconds: number,
  user: string = MACHINE_OS_USER,
): Promise<CommandResult | null> {
  return runner.run("timeout", [
    String(timeoutSeconds),
    "runuser",
    "-u",
    user,
    "--",
    "bash",
    // Interactive as well as login: many installers put their PATH line in
    // ~/.bashrc, which a non-interactive shell skips.
    "-lic",
    RUN_AS_USER_SCRIPT,
    "bash",
    ...argv,
  ]);
}

/** One installed package: its bare name and, when the manager says, its version. */
export interface UserPackage {
  readonly name: string;
  readonly version?: string;
}

const hasText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** `npm ls -g --depth=0 --json`: `{ "dependencies": { "<name>": { "version": ... } } }`. */
export function parseNpmGlobal(stdout: string): UserPackage[] {
  try {
    const parsed = JSON.parse(stdout) as { dependencies?: Record<string, { version?: unknown }> };
    // npm itself ships as a global package; it is the manager, not a tool someone added.
    return Object.entries(parsed.dependencies ?? {})
      .filter(([name]) => name !== "npm" && name !== "corepack")
      .map(([name, info]) => (hasText(info?.version) ? { name, version: info.version } : { name }));
  } catch {
    return [];
  }
}

/** `pipx list --json`: `{ "venvs": { "<name>": { "metadata": { "main_package": { "package_version" } } } } }`. */
export function parsePipxList(stdout: string): UserPackage[] {
  try {
    const parsed = JSON.parse(stdout) as {
      venvs?: Record<string, { metadata?: { main_package?: { package_version?: unknown } } }>;
    };
    return Object.entries(parsed.venvs ?? {}).map(([name, venv]) => {
      const version = venv?.metadata?.main_package?.package_version;
      return hasText(version) ? { name, version } : { name };
    });
  } catch {
    return [];
  }
}

/** `cargo install --list`: one unindented `<name> v<version>[ (<source>)]:` line per crate. */
export function parseCargoList(stdout: string): UserPackage[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith(" "))
    .map((line) => {
      const [name = "", rawVersion = ""] = line.replace(/:$/, "").split(" ");
      const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : "";
      return version ? { name, version } : { name };
    })
    .filter((pkg) => pkg.name.length > 0);
}

/** One element of the machine user's Nix profile that came from a nixpkgs attribute. */
export interface NixProfileElement extends UserPackage {
  /** What `nix profile remove` takes for it: the element's index (Nix 2.18) or name (2.20+). */
  readonly handle: string;
}

/**
 * The version in a store path's name. Nix's own rule: the name ends where a `-` is
 * followed by a digit (`/nix/store/<hash>-ripgrep-14.1.0` -> `14.1.0`).
 */
export function versionFromStorePath(storePath: string): string | undefined {
  const base = storePath.slice(storePath.lastIndexOf("/") + 1);
  // A non-default output carries its name at the end (`curl-8.23.0-bin`), which is not
  // part of the version.
  const name = base.slice(base.indexOf("-") + 1).replace(NIX_OUTPUT_SUFFIX, "");
  const match = /-(\d.*)$/.exec(name);
  return match?.[1];
}

const NIX_OUTPUT_SUFFIX = /-(bin|out|dev|lib|man|doc|info|devdoc|debug|static)$/;

/** `legacyPackages.x86_64-linux.python3Packages.black` -> `python3Packages.black`. */
function attrFromPath(attrPath: string): string | undefined {
  const match = /^(?:legacyPackages|packages)\.[^.]+\.(.+)$/.exec(attrPath);
  return match?.[1];
}

/**
 * `nix profile list --json`. Nix 2.18 (Ubuntu 24.04) writes `version: 2` with an
 * array of elements, removed by index. Nix 2.20 and later write `version: 3` with
 * elements keyed by name, removed by that name. Both are read, so a newer Nix does
 * not silently read as an empty profile.
 *
 * Elements not installed from a nixpkgs attribute (a bare store path, a local
 * flake) have no name Cloudable can declare, so they are left out.
 */
export function parseNixProfile(stdout: string): NixProfileElement[] {
  try {
    const parsed = JSON.parse(stdout) as { elements?: unknown };
    const raw = parsed.elements;
    const entries: Array<[string, unknown]> = Array.isArray(raw)
      ? raw.map((element, index) => [String(index), element])
      : raw && typeof raw === "object"
        ? Object.entries(raw)
        : [];
    const elements: NixProfileElement[] = [];
    for (const [handle, element] of entries) {
      if (!element || typeof element !== "object") continue;
      const { attrPath, storePaths } = element as { attrPath?: unknown; storePaths?: unknown };
      if (!hasText(attrPath)) continue;
      const name = attrFromPath(attrPath);
      if (!name || !isValidDeclaredPackageName(`nix:${name}`)) continue;
      const firstPath = Array.isArray(storePaths) ? storePaths[0] : undefined;
      const version = hasText(firstPath) ? versionFromStorePath(firstPath) : undefined;
      elements.push(version ? { name, version, handle } : { name, handle });
    }
    return elements;
  } catch {
    return [];
  }
}

interface ListCommand {
  readonly manager: UserManager;
  readonly argv: readonly string[];
  readonly parse: (stdout: string) => UserPackage[];
}

const LIST_COMMANDS: readonly ListCommand[] = [
  { manager: "npm", argv: ["npm", "ls", "-g", "--depth=0", "--json"], parse: parseNpmGlobal },
  // Ubuntu's npm puts globals in /usr. Cloudable moves the user's prefix to ~/.local
  // before its first npm install (`user-package-actions.ts`), so read /usr as well:
  // a tool someone installed there with sudo is still installed software.
  {
    manager: "npm",
    argv: ["npm", "ls", "-g", "--prefix", "/usr", "--depth=0", "--json"],
    parse: parseNpmGlobal,
  },
  { manager: "pipx", argv: ["pipx", "list", "--json"], parse: parsePipxList },
  { manager: "cargo", argv: ["cargo", "install", "--list"], parse: parseCargoList },
  {
    manager: "nix",
    argv: ["nix", ...NIX_FEATURES, "profile", "list", "--json"],
    parse: parseNixProfile,
  },
];

/** Every other-manager package installed for `user`, keyed by declared name, with versions. */
export async function listUserPackages(
  runner: CommandRunner = bunCommandRunner,
  user: string = MACHINE_OS_USER,
): Promise<Map<string, string | undefined>> {
  const results = await Promise.all(
    LIST_COMMANDS.map(async (command) => {
      const result = await runAsUser(runner, command.argv, 20, user);
      // npm exits 1 when the tree has problems (an extraneous package) but still prints it.
      if (result === null || result.stdout.trim().length === 0) return [];
      return command
        .parse(result.stdout)
        .map((pkg) => [`${command.manager}:${pkg.name}`, pkg.version] as const);
    }),
  );
  const packages = new Map<string, string | undefined>();
  for (const [name, version] of results.flat()) {
    if (!packages.has(name) || (version && !packages.get(name))) packages.set(name, version);
  }
  return packages;
}

/** The names only, sorted, as the report's `installedPackages` takes them. */
export async function listGlobalTools(
  runner: CommandRunner = bunCommandRunner,
  user: string = MACHINE_OS_USER,
): Promise<string[]> {
  return [...(await listUserPackages(runner, user)).keys()].sort();
}

export interface CachedUserPackages {
  (): Promise<Map<string, string | undefined>>;
  /** Forget the last answer, so the next call asks again. Called after any package action. */
  invalidate(): void;
}

/**
 * Reuses the last answer for a few minutes. Five login shells every 30-second
 * report is wasteful for something that changes when a person installs a tool.
 */
export function cachedUserPackages(
  intervalMs = 5 * 60 * 1000,
  list: () => Promise<Map<string, string | undefined>> = () => listUserPackages(),
  now: () => number = Date.now,
): CachedUserPackages {
  let last: { at: number; packages: Map<string, string | undefined> } | null = null;
  const cached = (async () => {
    if (last && now() - last.at < intervalMs) return last.packages;
    const packages = await list();
    last = { at: now(), packages };
    return packages;
  }) as CachedUserPackages;
  cached.invalidate = () => {
    last = null;
  };
  return cached;
}
