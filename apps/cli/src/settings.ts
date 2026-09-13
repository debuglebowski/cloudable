// ---------------------------------------------------------------------------
// `cloudable config set` and `cloudable config import` — desired state as
// data.
//
// `import` is the GitOps path: the same `applySettingChange` the console's
// dialogs call, applied entry by entry, so a file in a repo and a click in the
// UI leave the same events behind. Both are inert — they write desired state
// and never touch a machine (invariant 10); `cloudable machines reconcile`
// is what asks the agent to apply it.
// ---------------------------------------------------------------------------
import * as fs from "node:fs";
import { parseArgs, readSpec, required } from "./args";
import { CliError, EXIT, UsageError } from "./errors";
import { authenticatedApiRequest, patchJson, postJson } from "./http-client";
import { currentIdentity } from "./identity";
import { printJson, printTable } from "./output";
import { usageFor } from "./program";
import { machineId } from "./resolve";

interface SettingChange {
  scopeType: "org" | "machine";
  scopeId: string;
  key: string;
  previous: unknown;
  current: unknown;
}

/** `true`, `3`, `["/home"]` and `hello` all mean what they look like. */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function render(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

function printChanges(changes: ReadonlyArray<SettingChange>): void {
  printTable(
    ["scope", "key", "was", "now"],
    changes.map((change) => [
      `${change.scopeType}:${change.scopeId}`,
      change.key,
      render(change.previous),
      render(change.current),
    ]),
  );
}

export async function runConfigSetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor("config set <key> <value> [--machine <machine>] [--pinned]");
  const args = parseArgs(argv, readSpec({ values: ["machine"], booleans: ["pinned"] }));
  const key = required(args, 0, "a key", usage);
  const rawValue = args.positionals[1];
  if (rawValue === undefined) throw new UsageError(`a value is required\n\n${usage}`);

  const scopeType = args.flags.machine ? "machine" : "org";
  const scopeId = args.flags.machine
    ? await machineId(args.flags.machine)
    : (await currentIdentity()).orgId;

  const res = await authenticatedApiRequest<{ setting: SettingChange }>(
    "/api/v1/config/settings",
    patchJson({
      scopeType,
      scopeId,
      key,
      value: parseValue(rawValue),
      ...(args.booleans.has("pinned") ? { pinned: true } : {}),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  printChanges([res.setting]);
}

async function readImportFile(path: string): Promise<unknown> {
  const raw =
    path === "-" ? await new Response(Bun.stdin.stream()).text() : fs.readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new CliError(
      `${path} is not valid JSON.\n\n${cause instanceof Error ? cause.message : String(cause)}`,
      EXIT.usage,
    );
  }
}

export async function runConfigImportCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor("config import <file|-> [--correlation-id <id>]");
  const args = parseArgs(argv, readSpec({ values: ["correlation-id"] }));
  const path = required(args, 0, "a file (or - for stdin)", usage);
  const document = await readImportFile(path);

  // A bare array of entries, or the endpoint's own `{entries: [...]}` document.
  const entries = Array.isArray(document)
    ? document
    : typeof document === "object" &&
        document !== null &&
        Array.isArray((document as { entries?: unknown }).entries)
      ? (document as { entries: unknown[] }).entries
      : undefined;
  if (!entries) {
    throw new CliError(
      `${path} must hold either an array of entries or an object with an "entries" array.`,
      EXIT.usage,
    );
  }

  const res = await authenticatedApiRequest<{ applied: SettingChange[] }>(
    "/api/v1/config/import",
    postJson({
      entries,
      ...(args.flags["correlation-id"] ? { correlationId: args.flags["correlation-id"] } : {}),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.applied.length === 0) {
    console.log("Nothing changed — every entry already held that value.");
    return;
  }
  console.log(`Applied ${res.applied.length} of ${entries.length} entries.`);
  printChanges(res.applied);
}
