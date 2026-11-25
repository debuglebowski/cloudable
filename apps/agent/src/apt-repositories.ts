/**
 * The org's approved apt repositories, and the apt sources a machine really has.
 *
 * Two halves:
 *
 * - Apply. The poll's `settings.aptRepositories` lists the repositories an approver
 *   approved. The agent writes one deb822 `.sources` file and one key file per
 *   repository, removes the ones no longer listed, and runs `apt-get update` when
 *   anything changed. It owns only files named `cloudable-*`. A repository installs
 *   nothing by itself: packages from it are ordinary package actions.
 * - Report. Every enabled source URI in `sources.list` and `sources.list.d`, and the
 *   approved repositories that are in place. The control plane decides which sources
 *   are allowed and records each change (invariant 12).
 *
 * The agent runs as root and writes into `/etc/apt`, so the poll value is validated
 * here entry by entry. An invalid entry is skipped and logged, never written.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  APT_COMPONENT_PATTERN,
  APT_REPOSITORIES_POLL_KEY,
  APT_SUITE_PATTERN,
  type AptRepositoryConfig,
  type AptSourceReport,
} from "@cloudable/contracts";
import { type CommandRunner, bunCommandRunner } from "./installed-packages";

export const APT_DIR = "/etc/apt";

const FILE_PREFIX = "cloudable-";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
const KEY_END = "-----END PGP PUBLIC KEY BLOCK-----";
/** Armored keys are plain ASCII. Anything else is not a key. */
const ARMOR_CHARS = /^[\x20-\x7e\r\n\t]*$/;

const sourcesDir = (aptDir: string): string => join(aptDir, "sources.list.d");
const keyringsDir = (aptDir: string): string => join(aptDir, "keyrings");
const sourcesPath = (aptDir: string, id: string): string =>
  join(sourcesDir(aptDir), `${FILE_PREFIX}${id}.sources`);
const keyPath = (aptDir: string, id: string): string =>
  join(keyringsDir(aptDir), `${FILE_PREFIX}${id}.asc`);

/** Why an entry is not safe to write, or null when it is. Exported for the test. */
export function invalidReason(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return "not an object";
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || !UUID_PATTERN.test(e.id)) return "id is not a UUID";
  if (typeof e.url !== "string" || !e.url.startsWith("https://") || /\s/.test(e.url)) {
    return "url is not https:// or has whitespace";
  }
  try {
    if (new URL(e.url).protocol !== "https:") return "url is not https://";
  } catch {
    return "url does not parse";
  }
  if (typeof e.suite !== "string" || !APT_SUITE_PATTERN.test(e.suite)) return "suite is invalid";
  if (!Array.isArray(e.components)) return "components is not a list";
  for (const c of e.components) {
    if (typeof c !== "string" || !APT_COMPONENT_PATTERN.test(c)) return "a component is invalid";
  }
  // apt's rule: a flat repository (suite ending in `/`) has no components, any other has some.
  if (e.suite.endsWith("/") !== (e.components.length === 0)) {
    return "components do not fit the suite";
  }
  if (typeof e.signingKey !== "string") return "signingKey is not a string";
  const key = e.signingKey.trim();
  if (
    !ARMOR_CHARS.test(key) ||
    !key.startsWith(KEY_BEGIN) ||
    !key.endsWith(KEY_END) ||
    key.split("-----BEGIN ").length !== 2 ||
    key.split("-----END ").length !== 2
  ) {
    return "signingKey is not one armored public key";
  }
  return null;
}

/**
 * The valid repositories from the poll's settings. Absent or not a list means none.
 * An invalid or repeated entry is skipped and logged.
 */
export function aptRepositoriesFrom(
  settings: Readonly<Record<string, unknown>> | undefined,
  log: (message: string) => void = console.error,
): AptRepositoryConfig[] {
  const value = settings?.[APT_REPOSITORIES_POLL_KEY];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    log("apt repositories: setting is not a list, treating it as none");
    return [];
  }
  const seen = new Set<string>();
  const valid: AptRepositoryConfig[] = [];
  for (const entry of value) {
    const reason = invalidReason(entry);
    const id = (entry as { id?: unknown } | null)?.id;
    const label = typeof id === "string" ? id.slice(0, 64) : "?";
    if (reason !== null) {
      log(`apt repositories: skipping ${label}: ${reason}`);
      continue;
    }
    const repo = entry as AptRepositoryConfig;
    const key = repo.id.toLowerCase();
    if (seen.has(key)) {
      log(`apt repositories: skipping ${label}: listed twice`);
      continue;
    }
    seen.add(key);
    valid.push(repo);
  }
  return valid;
}

/** The deb822 file for one repository. Exported for the test. */
export function sourcesFileFor(repo: AptRepositoryConfig, aptDir: string = APT_DIR): string {
  const lines = [
    "# Written by Cloudable. An approved repository. Changes here are overwritten.",
    "Types: deb",
    `URIs: ${repo.url}`,
    `Suites: ${repo.suite}`,
    ...(repo.components.length > 0 ? [`Components: ${repo.components.join(" ")}`] : []),
    `Signed-By: ${keyPath(aptDir, repo.id)}`,
  ];
  return `${lines.join("\n")}\n`;
}

const keyFileFor = (repo: AptRepositoryConfig): string => `${repo.signingKey.trim()}\n`;

/** Writes `content` to `path` unless it already holds exactly that. True when it wrote. */
function writeIfChanged(path: string, content: string): boolean {
  const bytes = Buffer.from(content, "utf-8");
  try {
    if (readFileSync(path).equals(bytes)) return false;
  } catch {
    // Missing or unreadable: write it.
  }
  // Through a temp file and a rename, so apt never reads half a file.
  // apt ignores the `.tmp` name, and the next run overwrites a leftover one.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
  return true;
}

/** Ids of the `cloudable-<id><suffix>` files in `dir`. Never anything without the prefix. */
function cloudableIds(dir: string, suffix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(suffix))
    .map((name) => name.slice(FILE_PREFIX.length, name.length - suffix.length))
    .filter((id) => id.length > 0);
}

export interface ApplyAptRepositoriesOptions {
  readonly aptDir?: string;
  readonly runner?: CommandRunner;
  /** Run `apt-get update` even when no file changed: the last one failed. */
  readonly forceUpdate?: boolean;
  readonly log?: (message: string) => void;
}

export interface ApplyAptRepositoriesResult {
  /** Files written or removed. */
  readonly changed: number;
  /** True when `apt-get update` was needed and did not succeed. */
  readonly updateFailed: boolean;
}

/**
 * Makes the machine's `cloudable-*` apt files match `repos`, which must already be
 * validated (`aptRepositoriesFrom`). Writes only what differs. Removes `cloudable-*`
 * files whose id is not listed. Runs `apt-get update` once when anything changed.
 */
export async function applyAptRepositories(
  repos: readonly AptRepositoryConfig[],
  options: ApplyAptRepositoriesOptions = {},
): Promise<ApplyAptRepositoriesResult> {
  const aptDir = options.aptDir ?? APT_DIR;
  const runner = options.runner ?? bunCommandRunner;
  const log = options.log ?? console.error;
  let changed = 0;

  if (repos.length > 0) {
    mkdirSync(sourcesDir(aptDir), { recursive: true, mode: 0o755 });
    mkdirSync(keyringsDir(aptDir), { recursive: true, mode: 0o755 });
  }
  for (const repo of repos) {
    try {
      // The key first, so a sources file never names a key that is not there.
      if (writeIfChanged(keyPath(aptDir, repo.id), keyFileFor(repo))) changed += 1;
      if (writeIfChanged(sourcesPath(aptDir, repo.id), sourcesFileFor(repo, aptDir))) changed += 1;
    } catch (error) {
      log(`apt repositories: could not write ${repo.id}: ${String(error)}`);
    }
  }

  const wanted = new Set(repos.map((r) => r.id));
  // The sources file first, so apt never reads a source whose key is gone.
  const stale = [
    ...cloudableIds(sourcesDir(aptDir), ".sources")
      .filter((id) => !wanted.has(id))
      .map((id) => sourcesPath(aptDir, id)),
    ...cloudableIds(keyringsDir(aptDir), ".asc")
      .filter((id) => !wanted.has(id))
      .map((id) => keyPath(aptDir, id)),
  ];
  for (const path of stale) {
    try {
      unlinkSync(path);
      changed += 1;
    } catch (error) {
      log(`apt repositories: could not remove ${path}: ${String(error)}`);
    }
  }

  if (changed === 0 && !options.forceUpdate) return { changed, updateFailed: false };

  const result = await runner.run("apt-get", ["update"]);
  if (result === null || result.exitCode !== 0) {
    const detail = result === null ? "could not run" : `exit ${result.exitCode}`;
    log(`apt repositories: apt-get update failed (${detail}), will try again on the next change`);
    return { changed, updateFailed: true };
  }
  return { changed, updateFailed: false };
}

/** Ids of approved repositories in place: both the sources file and the key exist. */
export function readAptRepositoryIds(aptDir: string = APT_DIR): string[] {
  return cloudableIds(sourcesDir(aptDir), ".sources")
    .filter((id) => UUID_PATTERN.test(id) && existsSync(keyPath(aptDir, id)))
    .sort();
}

/** URIs from one-line `deb [opts] URI suite comps` lines. Exported for the test. */
export function parseOneLineSources(text: string): string[] {
  const uris: string[] = [];
  for (const raw of text.split("\n")) {
    const hash = raw.indexOf("#");
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (line === "") continue;
    const match = /^([A-Za-z-]+)\s*(?:\[[^\]]*\])?\s*(\S+)/.exec(line);
    if (match?.[1] !== "deb" || match[2] === undefined) continue;
    uris.push(match[2]);
  }
  return uris;
}

const DISABLED = new Set(["no", "false", "off", "without", "disable"]);

/** URIs from deb822 `.sources` stanzas. Exported for the test. */
export function parseDeb822Sources(text: string): string[] {
  const uris: string[] = [];
  const stanzas: Array<Map<string, string>> = [];
  let current = new Map<string, string>();
  let field: string | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (current.size > 0) stanzas.push(current);
      current = new Map();
      field = undefined;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (/^[ \t]/.test(line)) {
      // A continuation of the field above (a folded URIs list, an inline key).
      if (field !== undefined) current.set(field, `${current.get(field) ?? ""}\n${line}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      field = undefined;
      continue;
    }
    field = line.slice(0, colon).trim().toLowerCase();
    current.set(field, line.slice(colon + 1));
  }
  if (current.size > 0) stanzas.push(current);

  for (const stanza of stanzas) {
    const enabled = stanza.get("enabled")?.trim().toLowerCase();
    if (enabled !== undefined && DISABLED.has(enabled)) continue;
    const types = (stanza.get("types") ?? "").split(/\s+/);
    if (!types.includes("deb")) continue;
    for (const uri of (stanza.get("uris") ?? "").split(/\s+/)) {
      if (uri !== "") uris.push(uri);
    }
  }
  return uris;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Every enabled apt source on the machine: `sources.list`, and the `.list` and
 * `.sources` files in `sources.list.d`, the files apt itself reads. One entry per
 * file and URI. Unreadable files are skipped.
 */
export function readAptSources(aptDir: string = APT_DIR): AptSourceReport[] {
  const files: string[] = [join(aptDir, "sources.list")];
  try {
    for (const name of readdirSync(sourcesDir(aptDir)).sort()) {
      if (name.endsWith(".list") || name.endsWith(".sources")) {
        files.push(join(sourcesDir(aptDir), name));
      }
    }
  } catch {
    // No sources.list.d: only sources.list.
  }

  const reports: AptSourceReport[] = [];
  for (const file of files) {
    if (!isFile(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const uris = file.endsWith(".sources") ? parseDeb822Sources(text) : parseOneLineSources(text);
    for (const uri of new Set(uris)) reports.push({ file, uri });
  }
  return reports;
}
