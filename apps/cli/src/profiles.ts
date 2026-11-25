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
// is created, and cannot change while a machine uses the profile.
// See docs/inheritance.md.
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

function creationFields(p: ProfileSummary): string {
  const parts = [
    p.provider && `provider ${p.provider}`,
    p.region && `region ${p.region}`,
    p.sizeSku && `size ${p.sizeSku}`,
    p.image && `image ${p.image}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "-";
}

function printProfiles(items: ReadonlyArray<ProfileSummary>): void {
  printTable(
    ["name", "machines", "sets", "archived", "id"],
    items.map((p) => [
      p.name,
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
    ["provider", dash(p.provider)],
    ["region", dash(p.region)],
    ["size", dash(p.sizeSku)],
    ["image", dash(p.image)],
    ["machines", String(p.machineCount)],
    ["archived", p.archivedAt ?? "no"],
  ]);
  console.log("\nsettings:");
  if (p.settings.length === 0) console.log("  None. Its machines take every setting from the org.");
  else
    printTable(
      ["key", "value", "locked"],
      p.settings.map((s) => [s.key, JSON.stringify(s.value), s.locked ? "yes" : "no"]),
    );
  console.log("\npackages:");
  if (p.packages.length === 0) console.log("  None of its own.");
  else printPackages(p.packages);
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
    "profiles create --name <name> [--description <text>] [--provider azure|docker|fake] [--region <region>] [--size <sku>] [--image <image>]",
  );
  const args = parseArgs(argv, readSpec({ values: [...FIELD_FLAGS] }));
  if (!args.flags.name) throw new UsageError(`--name is required\n\n${usage}`);
  const profile = await authenticatedApiRequest<ProfileSummary>(
    "/api/v1/profiles",
    postJson(fieldsFromArgs(args.flags)),
  );
  if (args.booleans.has("json")) {
    printJson(profile);
    return;
  }
  console.log(`Created profile ${profile.name} (${profile.id}).`);
}

export async function runProfilesUpdateCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    "profiles update <profile> [--name <name>] [--description <text>|none] [--provider <p>|none] [--region <r>|none] [--size <sku>|none] [--image <image>|none]",
  );
  const args = parseArgs(argv, readSpec({ values: [...FIELD_FLAGS] }));
  const id = await profileId(required(args, 0, "a profile", usage));
  const body = fieldsFromArgs(args.flags);
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
