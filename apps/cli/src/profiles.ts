import type {
  ListProfilesResponse,
  PackageEnsureApprovalView,
  ProfileDetail,
  ProfilePackageEntry,
  ProfileSummary,
  UpdateProfileRequest,
} from "@cloudable/contracts";
// ---------------------------------------------------------------------------
// `cloudable profiles *` — named sets of settings machines link to.
//
// The chain is org → profile → machine; the lowest level that sets something
// wins. Editing a profile changes every machine on it that has not overridden
// the setting. Provider, region, size and image are used only when a machine
// is created. Each is a starting value the machine may differ from, unless
// it is locked. A locked one must match every machine on the profile.
//
// A profile may extend one base profile: org → base → profile → machine. One
// level only. See docs/inheritance.md.
// ---------------------------------------------------------------------------
import { oneOf, parseArgs, readSpec, required } from "./args";
import { CliError, EXIT, UsageError } from "./errors";
import { authenticatedApiRequest, patchJson, postJson } from "./http-client";
import {
  PACKAGE_EDIT_FLAGS,
  describeEnsureApprovals,
  packageEdits,
  settingLabel,
} from "./machines";
import { dash, printEmpty, printFields, printJson, printTable } from "./output";
import { usageFor } from "./program";
import { looksLikeId } from "./resolve";

const PROVIDERS = ["azure", "docker", "fake"] as const;

export async function listProfiles(): Promise<ProfileSummary[]> {
  const res = await authenticatedApiRequest<ListProfilesResponse>("/api/v1/profiles");
  return res.items;
}

/** A name or an id to the profile's id. An archived profile still resolves by name. */
export async function profileId(nameOrId: string): Promise<string> {
  if (looksLikeId(nameOrId)) return nameOrId;
  const items = await listProfiles();
  const match =
    items.find((p) => p.name === nameOrId) ??
    items.find((p) => p.name.toLowerCase() === nameOrId.toLowerCase());
  if (!match) {
    throw new CliError(
      `no profile named '${nameOrId}'.\n\nRun \`cloudable profiles list\` to see them.`,
      EXIT.notFound,
    );
  }
  return match.id;
}

const CREATION_FIELDS = [
  ["provider", "provider"],
  ["region", "region"],
  ["sizeSku", "size"],
  ["image", "image"],
] as const;

/** What a new machine on the profile gets. A locked value says so. */
function creationFields(p: ProfileSummary): string {
  const parts = CREATION_FIELDS.filter(([field]) => p.creation[field].value !== null).map(
    ([field, label]) =>
      `${label} ${p.creation[field].value}${p.creation[field].locked ? " (locked)" : ""}`,
  );
  return parts.length > 0 ? parts.join(", ") : "-";
}

/** One creation field for `profiles get`: the value, and whether it is locked. */
function creationField(p: ProfileSummary, field: (typeof CREATION_FIELDS)[number][0]): string {
  const resolved = p.creation[field];
  if (resolved.value === null) return "-";
  const from = resolved.fromProfileId !== p.id ? `, from base ${p.baseProfileName}` : "";
  return `${resolved.value} (${resolved.locked ? "locked" : "starting value"}${from})`;
}

function printProfiles(items: ReadonlyArray<ProfileSummary>): void {
  printTable(
    ["name", "extends", "machines", "sets", "archived", "id"],
    items.map((p) => [
      p.name,
      dash(p.baseProfileName),
      String(p.machineCount),
      creationFields(p),
      p.archivedAt ? p.archivedAt.slice(0, 10) : "-",
      p.id,
    ]),
  );
}

function printPackages(items: ReadonlyArray<ProfilePackageEntry>): void {
  printTable(
    ["package", "version", "locked", "setting", "part of", "description"],
    items.map((entry) => [
      entry.packageName,
      dash(entry.versionPin),
      entry.locked ? "yes" : "no",
      settingLabel(entry.setting),
      dash(entry.partOf),
      dash(entry.description),
    ]),
  );
}

function printProfile(p: ProfileDetail): void {
  printFields([
    ["name", p.name],
    ["id", p.id],
    ["description", dash(p.description)],
    ["extends", dash(p.baseProfileName)],
    ["extended by", `${p.extendedBy} profile(s)`],
    ["provider", creationField(p, "provider")],
    ["region", creationField(p, "region")],
    ["size", creationField(p, "sizeSku")],
    ["image", creationField(p, "image")],
    ["machines", String(p.machineCount)],
    ["archived", p.archivedAt ?? "no"],
  ]);
  const above = p.base ? `its base, ${p.base.name}, or the org` : "the org";
  console.log("\nsettings:");
  if (p.settings.length === 0)
    console.log(`  None of its own. Its machines take them from ${above}.`);
  else
    printTable(
      ["key", "value", "locked"],
      p.settings.map((s) => [s.key, JSON.stringify(s.value), s.locked ? "yes" : "no"]),
    );
  console.log("\npackages:");
  if (p.packages.length === 0) console.log("  None of its own.");
  else printPackages(p.packages);
  if (p.base) {
    console.log(`\nfrom base ${p.base.name}, unless set above:`);
    if (p.base.settings.length > 0)
      printTable(
        ["key", "value", "locked"],
        p.base.settings.map((s) => [s.key, JSON.stringify(s.value), s.locked ? "yes" : "no"]),
      );
    if (p.base.packages.length > 0) printPackages(p.base.packages);
    if (p.base.settings.length === 0 && p.base.packages.length === 0) console.log("  Nothing.");
  }
}

export async function runProfilesListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const items = await listProfiles();
  if (args.booleans.has("json")) {
    printJson({ items });
    return;
  }
  if (items.length === 0) {
    printEmpty("profiles");
    return;
  }
  printProfiles(items);
}

export async function runProfilesGetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = await profileId(required(args, 0, "a profile", usageFor("profiles get <profile>")));
  const profile = await authenticatedApiRequest<ProfileDetail>(`/api/v1/profiles/${id}`);
  if (args.booleans.has("json")) {
    printJson(profile);
    return;
  }
  printProfile(profile);
}

const FIELD_FLAGS = ["name", "description", "provider", "region", "size", "image"] as const;
const CREATE_FLAGS = [...FIELD_FLAGS, "extends"] as const;
const LOCK_FLAGS = ["lock", "unlock"] as const;
const LOCKABLE = ["provider", "region", "size", "image"] as const;
const LOCK_KEY = {
  provider: "providerLocked",
  region: "regionLocked",
  size: "sizeLocked",
  image: "imageLocked",
} as const;

/** `--lock size --unlock image`: which creation fields to lock or unlock. */
function locksFromArgs(all: Readonly<Record<string, ReadonlyArray<string>>>): UpdateProfileRequest {
  const body: UpdateProfileRequest = {};
  for (const flag of LOCK_FLAGS) {
    for (const raw of all[flag] ?? []) {
      body[LOCK_KEY[oneOf(raw, LOCKABLE, flag)]] = flag === "lock";
    }
  }
  return body;
}

/** `none` clears a field; anything else sets it. Only the flags given are sent. */
function fieldsFromArgs(flags: Readonly<Record<string, string | undefined>>): UpdateProfileRequest {
  const value = (key: string): string | null | undefined => {
    const raw = flags[key];
    if (raw === undefined) return undefined;
    return raw === "none" ? null : raw;
  };
  const body: UpdateProfileRequest = {};
  const name = flags.name;
  if (name !== undefined) body.name = name;
  const description = value("description");
  if (description !== undefined) body.description = description;
  const provider = value("provider");
  if (provider !== undefined)
    body.provider = provider === null ? null : oneOf(provider, PROVIDERS, "provider");
  const region = value("region");
  if (region !== undefined) body.region = region;
  const size = value("size");
  if (size !== undefined) body.sizeSku = size;
  const image = value("image");
  if (image !== undefined) body.image = image;
  return body;
}

export async function runProfilesCreateCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "profiles create --name <name> [--extends <profile>] [--description <text>] [--provider azure|docker|fake] [--region <region>] [--size <sku>] [--image <image>] [--lock provider|region|size|image]",
  );
  const args = parseArgs(
    argv,
    readSpec({ values: [...CREATE_FLAGS], repeatable: [...LOCK_FLAGS] }),
  );
  if (!args.flags.name) throw new UsageError(`--name is required\n\n${usage}`);
  const base = args.flags.extends ? await profileId(args.flags.extends) : undefined;
  const profile = await authenticatedApiRequest<ProfileSummary>(
    "/api/v1/profiles",
    postJson({
      ...fieldsFromArgs(args.flags),
      ...locksFromArgs(args.all),
      ...(base ? { baseProfileId: base } : {}),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(profile);
    return;
  }
  console.log(`Created profile ${profile.name} (${profile.id}).`);
}

export async function runProfilesUpdateCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "profiles update <profile> [--name <name>] [--description <text>|none] [--provider <p>|none] [--region <r>|none] [--size <sku>|none] [--image <image>|none] [--lock <field>] [--unlock <field>]",
  );
  const args = parseArgs(argv, readSpec({ values: [...FIELD_FLAGS], repeatable: [...LOCK_FLAGS] }));
  const id = await profileId(required(args, 0, "a profile", usage));
  const body = { ...fieldsFromArgs(args.flags), ...locksFromArgs(args.all) };
  if (Object.keys(body).length === 0) throw new UsageError(`nothing to change\n\n${usage}`);
  const profile = await authenticatedApiRequest<ProfileSummary>(
    `/api/v1/profiles/${id}`,
    patchJson(body),
  );
  if (args.booleans.has("json")) {
    printJson(profile);
    return;
  }
  console.log(`Updated profile ${profile.name}.`);
}

export async function runProfilesSetBaseCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor("profiles set-base <profile> <base|none>");
  const args = parseArgs(argv, readSpec());
  const id = await profileId(required(args, 0, "a profile", usage));
  const target = required(args, 1, "a base profile, or none", usage);
  const base = target === "none" ? null : await profileId(target);
  const profile = await authenticatedApiRequest<ProfileSummary>(`/api/v1/profiles/${id}/base`, {
    method: "PUT",
    body: JSON.stringify({ baseProfileId: base }),
  });
  if (args.booleans.has("json")) {
    printJson(profile);
    return;
  }
  console.log(
    profile.baseProfileName
      ? `${profile.name} extends ${profile.baseProfileName} now. Its machines take what it does not set from there.`
      : `${profile.name} extends no profile now. Its machines take what it does not set from the org.`,
  );
}

export async function runProfilesArchiveCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = await profileId(
    required(args, 0, "a profile", usageFor("profiles archive <profile>")),
  );
  const profile = await authenticatedApiRequest<ProfileSummary>(
    `/api/v1/profiles/${id}/archive`,
    postJson({}),
  );
  if (args.booleans.has("json")) {
    printJson(profile);
    return;
  }
  console.log(
    `Archived profile ${profile.name}. No new machine can use it. ${profile.machineCount} machine(s) on it keep its settings.`,
  );
}

export async function runProfilesPackagesSetCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "profiles packages set <profile> [--add <pkg>[@<version>]] [--lock <pkg>[@<version>]] [--remove <pkg>] [--part-of <parent>] [--description <text>] [--standalone <pkg>] [--ensure <pkg>] [--ensure-latest <pkg>] [--allow <pkg>]",
  );
  const args = parseArgs(
    argv,
    readSpec({ values: ["part-of", "description"], repeatable: [...PACKAGE_EDIT_FLAGS] }),
  );
  const id = await profileId(required(args, 0, "a profile", usage));
  const { upserts, removals } = packageEdits(args);
  if (upserts.length === 0 && removals.length === 0) {
    throw new UsageError(`nothing to change\n\n${usage}`);
  }
  const res = await authenticatedApiRequest<{
    items: ProfilePackageEntry[];
    ensureApprovals?: PackageEnsureApprovalView[];
  }>(
    `/api/v1/profiles/${id}/packages`,
    patchJson({
      ...(upserts.length > 0 ? { upserts } : {}),
      ...(removals.length > 0 ? { removals } : {}),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  console.log("Profile packages updated. Every machine on it without its own entry follows.");
  for (const line of describeEnsureApprovals(res.ensureApprovals ?? [], upserts)) console.log(line);
  printPackages(res.items);
}
