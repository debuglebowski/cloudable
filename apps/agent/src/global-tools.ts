import { MACHINE_OS_USER } from "@cloudable/contracts";
import { type CommandRunner, bunCommandRunner } from "./installed-packages";

/**
 * Globally installed tools from package managers other than apt, reported as
 * `<manager>:<name>` (`npm:@openai/codex`, `pipx:black`, `cargo:ripgrep`), so the
 * "no undeclared software" check can judge them the same way as apt packages.
 * See `PACKAGE_MANAGERS` in the contracts package for the naming rule.
 *
 * Only what each manager itself calls global. Project dependencies
 * (`node_modules`, a virtualenv) are not reported, and nothing scans folders.
 *
 * Every command runs as the machine's own user, not as root: that user's tools
 * live under its own prefix (`~/.local`), and asking as root would answer for
 * a different install. It runs through the user's own shell setup so their
 * PATH finds them. `timeout` bounds a slow or hanging manager.
 *
 * A manager that is absent or fails contributes nothing. That is the same as
 * having no global tools, which is the honest reading: nothing was found.
 */

interface ToolManager {
  readonly prefix: "npm" | "pipx" | "cargo";
  readonly command: string;
  readonly parse: (stdout: string) => string[];
}

/** `npm ls -g --depth=0 --json`: `{ "dependencies": { "<name>": {...} } }`. */
export function parseNpmGlobal(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { dependencies?: Record<string, unknown> };
    // npm itself ships as a global package; it is the manager, not a tool someone added.
    return Object.keys(parsed.dependencies ?? {}).filter(
      (name) => name !== "npm" && name !== "corepack",
    );
  } catch {
    return [];
  }
}

/** `pipx list --json`: `{ "venvs": { "<name>": {...} } }`. */
export function parsePipxList(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { venvs?: Record<string, unknown> };
    return Object.keys(parsed.venvs ?? {});
  } catch {
    return [];
  }
}

/** `cargo install --list`: one unindented `<name> v<version>:` line per crate. */
export function parseCargoList(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith(" "))
    .map((line) => line.split(" ")[0] ?? "")
    .filter((name) => name.length > 0);
}

const MANAGERS: readonly ToolManager[] = [
  { prefix: "npm", command: "npm ls -g --depth=0 --json", parse: parseNpmGlobal },
  { prefix: "pipx", command: "pipx list --json", parse: parsePipxList },
  { prefix: "cargo", command: "cargo install --list", parse: parseCargoList },
];

export async function listGlobalTools(
  runner: CommandRunner = bunCommandRunner,
  user: string = MACHINE_OS_USER,
): Promise<string[]> {
  const results = await Promise.all(
    MANAGERS.map(async (manager) => {
      const result = await runner.run("timeout", [
        "20",
        "runuser",
        "-u",
        user,
        "--",
        "bash",
        // Interactive as well as login: many installers put their PATH line in
        // ~/.bashrc, which a non-interactive shell skips. stderr is discarded.
        "-lic",
        // `command -v` first, so an absent manager is a quiet empty answer, not an error.
        `command -v ${manager.command.split(" ")[0]} >/dev/null 2>&1 && ${manager.command}`,
      ]);
      // npm exits 1 when the tree has problems (an extraneous package) but still prints it.
      if (result === null || result.stdout.trim().length === 0) return [];
      return manager.parse(result.stdout).map((name) => `${manager.prefix}:${name}`);
    }),
  );
  return [...new Set(results.flat())].sort();
}

/**
 * Reuses the last answer for a few minutes. Three login shells every 30-second
 * report is wasteful for something that changes when a person installs a tool.
 */
export function cachedGlobalTools(
  intervalMs = 5 * 60 * 1000,
  list: () => Promise<string[]> = () => listGlobalTools(),
  now: () => number = Date.now,
): () => Promise<string[]> {
  let last: { at: number; tools: string[] } | null = null;
  return async () => {
    if (last && now() - last.at < intervalMs) return last.tools;
    const tools = await list();
    last = { at: now(), tools };
    return tools;
  };
}
