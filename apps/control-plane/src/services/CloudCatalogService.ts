// Populates `providerCatalogEntries` (packages/schema/src/tables/
// provider-catalog.ts) — the global "what does this provider actually
// offer" reference data an org curates its own allow-list against (see
// `domain/organisation/catalog.ts`). Regions and sizes are real, live Azure
// SDK calls; images are seeded from `ProvisioningService.azure.ts`'s own
// `UBUNTU_IMAGES` map, since Azure has no API enumerating "images
// compatible with our cloud-init setup" the way it does for regions/sizes.
import { ComputeManagementClient } from "@azure/arm-compute";
import { SubscriptionClient } from "@azure/arm-subscriptions";
import { DefaultAzureCredential } from "@azure/identity";
import { providerCatalogEntries } from "@cloudable/schema";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { ulid } from "ulid";
import { config } from "../config";
import { Db } from "../db/layer";
import { UBUNTU_IMAGES } from "./ProvisioningService.azure";

export class CloudCatalogError extends Data.TaggedError("CloudCatalogError")<{
  reason: string;
  cause?: unknown;
}> {}

/**
 * This deployment has no `AZURE_SUBSCRIPTION_ID` configured — a foreseeable,
 * actionable state (self-hosting without Azure at all, or not yet set up),
 * not our own infra breaking. `Schema.TaggedError` with fields nested under
 * `error` (not `CloudCatalogError`'s plain `reason`/`cause`) so it crosses
 * the HTTP boundary via `.addError()` as a real status code instead of the
 * handler `Effect.die`-ing it into an opaque 500 — same convention as
 * `domain/machine/errors.ts`.
 */
export class AzureNotConfiguredError extends Schema.TaggedError<AzureNotConfiguredError>(
  "AzureNotConfiguredError",
)("AzureNotConfiguredError", {
  error: Schema.Struct({
    code: Schema.Literal("azure_not_configured"),
    message: Schema.String,
    requestId: Schema.String,
  }),
}) {}

const notConfiguredError = () =>
  new AzureNotConfiguredError({
    error: {
      code: "azure_not_configured",
      message:
        "This deployment has no AZURE_SUBSCRIPTION_ID configured — there's no Azure subscription to sync a catalog from.",
      requestId: ulid(),
    },
  });

/** Same tagged error, different actionable message — reused rather than a new error
 * type so the HTTP layer's existing `.addError(AzureNotConfiguredError, {status: 409})`
 * on the sync endpoints (`http/routes/catalog.ts`) needs no new wiring. See
 * `syncAzureSizes`'s own doc comment for why this is a hard failure now, not a slow
 * fallback. */
const locationNotConfiguredError = () =>
  new AzureNotConfiguredError({
    error: {
      code: "azure_not_configured",
      message:
        "This deployment has no AZURE_MACHINES_LOCATION configured — refusing to sync sizes without one rather than falling back to an unfiltered, subscription-wide call (confirmed to take 80s+ against a real subscription). Every Terraform-provisioned deployment sets this automatically from its resource group's location; a manually-maintained local .env needs it added by hand.",
      requestId: ulid(),
    },
  });

export type CatalogKind = "region" | "image" | "sku";

export interface CatalogEntry {
  code: string;
  displayName: string;
  /** Only ever set by `syncAzureSizes` — regions/images have no such
   * concept and leave these `undefined`, stored as `null`. */
  vcpus?: number;
  memoryGb?: number;
  /** Set by `syncAzureSizes` (what the size runs on) and `seedAzureImages`
   * (what the image requires) — regions leave this `undefined`. See
   * `provider-catalog.ts`'s own doc comment on this dual meaning. */
  architecture?: string;
}

/** One multi-row statement per chunk rather than one round-trip per row —
 * `syncAzureSizes` alone can pass several hundred entries (this
 * subscription's raw `resourceSkus.list()` enumerates tens of thousands of
 * per-region SKU records before dedup), and a sequential
 * `for (...) await tx.insert(...)` loop over that many rows, all inside one
 * held-open transaction, was slow enough to blow past Azure Container
 * Apps' request/probe patience — confirmed live: the container was
 * silently SIGKILLed mid-sync (no app-level error logged at all) and
 * restarted, which is what a caller actually saw as a 503. Chunked well
 * under Postgres's ~65535 bound-parameter limit (6 params/row here). */
const UPSERT_CHUNK_SIZE = 1000;

export const upsertEntries = (
  provider: "azure",
  kind: CatalogKind,
  entries: ReadonlyArray<CatalogEntry>,
): Effect.Effect<void, CloudCatalogError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          for (let i = 0; i < entries.length; i += UPSERT_CHUNK_SIZE) {
            const chunk = entries.slice(i, i + UPSERT_CHUNK_SIZE);
            if (chunk.length === 0) continue;
            await tx
              .insert(providerCatalogEntries)
              .values(
                chunk.map((entry) => ({
                  provider,
                  kind,
                  code: entry.code,
                  displayName: entry.displayName,
                  vcpus: entry.vcpus ?? null,
                  memoryGb: entry.memoryGb ?? null,
                  architecture: entry.architecture ?? null,
                })),
              )
              .onConflictDoUpdate({
                target: [
                  providerCatalogEntries.provider,
                  providerCatalogEntries.kind,
                  providerCatalogEntries.code,
                ],
                set: {
                  displayName: sql`excluded.display_name`,
                  vcpus: sql`excluded.vcpus`,
                  memoryGb: sql`excluded.memory_gb`,
                  architecture: sql`excluded.architecture`,
                  syncedAt: new Date(),
                },
              });
          }

          // Prune anything for this exact (provider, kind) that this sync no longer
          // returned — a real two-way sync, not additive-only. Without this, a SKU
          // that stops matching today's filters (retired, region changed, no longer
          // Gen2/offered-architecture — see syncAzureSizes) keeps its old row
          // forever: null vcpus/memoryGb/architecture from before those columns
          // existed, or just genuinely stale, but still fully selectable in the Add
          // Machine wizard (computeCompatibility treats a null architecture as
          // "always compatible", so a stale row is indistinguishable from a real one
          // except for its blank spec columns). Guarded on entries.length > 0: an
          // empty result more likely means a transient Azure/auth hiccup than "zero
          // sizes actually exist" — better to leave stale data in place than wipe an
          // entire kind because one sync call came back empty. Scoped to this exact
          // (provider, kind) — a sku sync never touches region/image rows.
          if (entries.length > 0) {
            await tx.delete(providerCatalogEntries).where(
              and(
                eq(providerCatalogEntries.provider, provider),
                eq(providerCatalogEntries.kind, kind),
                notInArray(
                  providerCatalogEntries.code,
                  entries.map((entry) => entry.code),
                ),
              ),
            );
          }
        }),
      catch: (cause) => new CloudCatalogError({ reason: "upsert_failed", cause }),
    });
  });

/** Same lazy, memoized, fail-closed-if-unconfigured shape as
 * `ProvisioningService.azure.ts`'s own `getClients` — deliberately not
 * shared with it (a `CloudCatalogService.syncRegions` call and a real
 * provisioning call have no reason to be coupled through one cache). */
let cachedSubscriptionClient: { client: SubscriptionClient; subscriptionId: string } | null = null;

const getSubscriptionClient = (): Effect.Effect<
  { client: SubscriptionClient; subscriptionId: string },
  AzureNotConfiguredError
> =>
  Effect.gen(function* () {
    if (cachedSubscriptionClient) return cachedSubscriptionClient;
    const subscriptionId = config.azureSubscriptionId;
    if (!subscriptionId) {
      return yield* Effect.fail(notConfiguredError());
    }
    cachedSubscriptionClient = {
      client: new SubscriptionClient(new DefaultAzureCredential()),
      subscriptionId,
    };
    return cachedSubscriptionClient;
  });

/** Real Azure SDK call — `SubscriptionClient.subscriptions.listLocations()`
 * enumerates every region the configured subscription can provision into.
 * Filtered client-side to `config.azureMachinesLocation` when set (unlike
 * `syncAzureSizes`'s server-side OData filter, `listLocations()` has no such
 * parameter — the call itself is always the same cheap ~60-region list, so
 * this filter is about correctness, not the latency `syncAzureSizes` had to
 * fix): self-hosted mode has exactly one usable region — wherever the
 * machines vnet/subnet actually live — so offering the rest of Azure's ~60
 * regions here isn't a convenience, it's a trap. Enabling any other region in
 * an org's catalog produces machines that are guaranteed to fail provisioning
 * (a NIC can't join a subnet outside its own region — seen live:
 * `InvalidResourceReference` on a machine created against a region the vnet
 * doesn't exist in). Falls back to the unfiltered, every-region list only
 * when the location isn't known (e.g. an older deploy that hasn't picked up
 * `AZURE_MACHINES_LOCATION` yet) — kept here since, unlike sizes, there's no
 * slow path to fail fast against. `upsertEntries` prunes any previously-
 * synced region this call doesn't return, same as sizes/images — no
 * region-specific exception. */
export const syncAzureRegions = (): Effect.Effect<
  ReadonlyArray<CatalogEntry>,
  CloudCatalogError | AzureNotConfiguredError,
  Db
> =>
  Effect.gen(function* () {
    const { client, subscriptionId } = yield* getSubscriptionClient();
    const location = config.azureMachinesLocation;
    const locations = yield* Effect.tryPromise({
      try: async () => {
        const results = [];
        for await (const loc of client.subscriptions.listLocations(subscriptionId)) {
          results.push(loc);
        }
        return results;
      },
      catch: (cause) => new CloudCatalogError({ reason: "list_locations_failed", cause }),
    });

    const entries: CatalogEntry[] = locations
      .filter((loc): loc is typeof loc & { name: string } => Boolean(loc.name))
      .filter((loc) => !location || loc.name === location)
      .map((loc) => ({
        code: loc.name,
        displayName: loc.displayName ?? loc.name,
      }));

    yield* upsertEntries("azure", "region", entries);
    return entries;
  });

/** Same lazy, memoized, fail-closed-if-unconfigured shape as
 * `getSubscriptionClient` above — its own doc comment's "deliberately not
 * shared with `ProvisioningService.azure.ts`" reasoning applies here too, so
 * this is a second, independent cache, not a reuse of that file's own
 * `ComputeManagementClient` instance. */
let cachedComputeClient: { client: ComputeManagementClient; subscriptionId: string } | null = null;

const getComputeClient = (): Effect.Effect<
  { client: ComputeManagementClient; subscriptionId: string },
  AzureNotConfiguredError
> =>
  Effect.gen(function* () {
    if (cachedComputeClient) return cachedComputeClient;
    const subscriptionId = config.azureSubscriptionId;
    if (!subscriptionId) {
      return yield* Effect.fail(notConfiguredError());
    }
    cachedComputeClient = {
      client: new ComputeManagementClient(new DefaultAzureCredential(), subscriptionId),
      subscriptionId,
    };
    return cachedComputeClient;
  });

/** `sku.name` alone ("Standard_A1_v2") means nothing to a person choosing a
 * size — `vCPUs`/`MemoryGB` are two of the ~25 flat name/value pairs Azure
 * returns per SKU in `capabilities` (confirmed against a real subscription;
 * no typed fields for these, just this free-form list), enough to make the
 * choice legible without going as far as parsing the rest (family, disk
 * IOPS, etc.) that a self-hoster picking a size doesn't need. Falls back to
 * the bare name if a SKU is ever missing one of the two — seen in practice
 * for some retired/specialty SKUs. */
const skuDisplayName = (sku: {
  name?: string;
  capabilities?: { name?: string; value?: string }[];
}): string => {
  const vcpus = sku.capabilities?.find((c) => c.name === "vCPUs")?.value;
  const memoryGb = sku.capabilities?.find((c) => c.name === "MemoryGB")?.value;
  if (!vcpus || !memoryGb) return sku.name ?? "";
  return `${sku.name} (${vcpus} vCPU, ${memoryGb} GB RAM)`;
};

/** Every image this adapter offers (`UBUNTU_IMAGES` in
 * `ProvisioningService.azure.ts`) is Hypervisor Generation 2 only — Canonical
 * doesn't even publish a Generation 1 offer for 24.04 anymore, and 22.04's
 * offer here is explicitly the "-gen2" SKU. A size whose own
 * `HyperVGenerations` capability doesn't include `"V2"` (comma-separated,
 * e.g. `"V1,V2"` or bare `"V1"`) can never boot either image — confirmed
 * live: `Standard_A4m_v2` (`HyperVGenerations: "V1"`) picked from the
 * unfiltered catalog failed VM creation with exactly this mismatch. Missing
 * the capability entirely (seen on some retired/specialty SKUs) is treated
 * as "no", not "maybe" — same conservative default as `skuDisplayName`
 * falling back to the bare name above.
 *
 * This stays a hard, unconditional generation check (not folded into the
 * per-image compatibility comparison below) because every image this
 * deployment could ever offer requires Gen2 — there's no real "depends which
 * image you pick" case for hypervisor generation today, unlike architecture
 * (see `syncAzureSizes`'s own doc comment on that distinction). */
export const isGen2Capable = (sku: {
  capabilities?: { name?: string; value?: string }[];
}): boolean => {
  const generations = sku.capabilities?.find((c) => c.name === "HyperVGenerations")?.value;
  return generations?.split(",").includes("V2") ?? false;
};

/** Azure flags a SKU it plans to stop offering with a `RetirementDateUtc`
 * capability — present or not, regardless of the actual date. Excluding it
 * from the sync is the same kind of objective, non-opinionated fact as
 * `isGen2Capable` above (not Cloudable curating a "good" size list by
 * taste — that's the org admin's call, not this deployment's): a governed,
 * potentially long-lived machine shouldn't be provisioned onto a size Azure
 * has already announced it will remove. */
export const isScheduledForRetirement = (sku: {
  capabilities?: { name?: string; value?: string }[];
}): boolean => sku.capabilities?.some((c) => c.name === "RetirementDateUtc") ?? false;

/** Azure attaches a `restrictions` entry to a SKU it can't be used somewhere —
 * `type: "Location"` restrictions are exactly what our own sync already scopes
 * to (`config.azureMachinesLocation`), so a SKU whose restrictions cover that
 * region can never actually provision here, regardless of what its other
 * capabilities say. Confirmed live: `Standard_B4as_v2` passed every other
 * filter (Gen2, not retired, x64) but reliably failed VM creation with
 * `quota_exceeded: ... currently not available in location 'northeurope'` —
 * exactly what its own restrictions array already said (`reasonCode:
 * "NotAvailableForSubscription", type: "Location", values: ["northeurope"]`,
 * confirmed via `az vm list-skus --size Standard_B4as_v2 --all`), the sync
 * just wasn't checking it. Deliberately NOT excluding `type: "Zone"`
 * restrictions (a SKU restricted in only some availability zones within an
 * otherwise-fine region): this deployment's VM creation never pins a zone
 * (`ProvisioningService.azure.ts`), so Azure can still place it in whichever
 * zone isn't restricted — excluding on a partial zone restriction would
 * over-exclude sizes that actually work. Same "objective, will-never-work
 * fact" category as `isGen2Capable`/`isScheduledForRetirement` above, not
 * curation by taste. */
export const isRestrictedInLocation = (
  sku: { restrictions?: { type?: string; values?: string[] }[] },
  location: string,
): boolean =>
  sku.restrictions?.some((r) => r.type === "Location" && r.values?.includes(location)) ?? false;

/** `sku.capabilities` is Azure's own flat name/value list (see
 * `skuDisplayName`'s doc comment) — this pulls one out as a number for the
 * console's vCPU/RAM filter (`catalog-checklist.tsx`), same lookup
 * `skuDisplayName` does for display, just typed and reused for filtering
 * instead of formatting. */
const numericCapability = (
  sku: { capabilities?: { name?: string; value?: string }[] },
  name: string,
): number | undefined => {
  const value = sku.capabilities?.find((c) => c.name === name)?.value;
  return value ? Number(value) : undefined;
};

/** Same lookup as `numericCapability`, string-valued — used for
 * `"CpuArchitectureType"` (e.g. `"x64"`, `"Arm64"`), the size's own
 * architecture capability. */
const stringCapability = (
  sku: { capabilities?: { name?: string; value?: string }[] },
  name: string,
): string | undefined => sku.capabilities?.find((c) => c.name === name)?.value;

/** The set of architectures at least one image this deployment offers
 * actually requires (from `UBUNTU_IMAGES`) — a size whose own architecture
 * isn't in this set can never pair with anything this adapter would ever
 * try to boot, so it's excluded from the sync entirely (the same
 * "objective, will-never-work fact" reasoning as `isGen2Capable` and
 * `isScheduledForRetirement`, not a curation judgment). Sizes that *do*
 * match are still filtered per-image at compatibility-check time
 * (`MachineService.create`, the Add Machine form) — this only rules out
 * "matches no image at all." */
const offeredImageArchitectures = new Set(
  Object.values(UBUNTU_IMAGES).map((image) => image.architecture),
);

/** `undefined` architecture (a SKU with no `CpuArchitectureType` capability
 * at all) is treated as "no", same conservative default as `isGen2Capable`. */
export const isOfferedArchitecture = (architecture: string | undefined): boolean =>
  architecture !== undefined && offeredImageArchitectures.has(architecture);

/** Real Azure SDK call — `ComputeManagementClient.resourceSkus.list()`
 * enumerates every SKU (VM sizes, disks, etc.) available to the configured
 * subscription; filtered to `resourceType === "virtualMachines"` for just
 * the VM sizes a machine's `sizeSku` actually names.
 *
 * Always filtered server-side to `config.azureMachinesLocation` (the one
 * region `AZURE_MACHINES_SUBNET_ID` actually lives in — self-hosted mode has
 * no other usable region, since machines always join that one fixed subnet;
 * `lockedRegion` in `provisioning-capabilities.ts` is this exact same value,
 * so the wizard's own "region chosen first" ordering and this sync are
 * already talking about the one region a deployment has). This used to fall
 * back to an unfiltered, subscription-wide call when the location wasn't
 * set — real, load-bearing difference, not an optimization: unfiltered
 * against a real subscription this API took 80-90s+ (confirmed live; tens of
 * thousands of raw per-region SKU records across every Azure region, versus
 * a few seconds for one). That fallback is gone: every Terraform-provisioned
 * deployment sets `AZURE_MACHINES_LOCATION` automatically (from the resource
 * group's own location, `infra/terraform/control-plane/main.tf`), so a
 * missing location only ever means local dev's hand-maintained `.env` is
 * incomplete — worth failing fast and telling the operator that, not quietly
 * eating a minute-plus ARM call as if it were expected. `upsertEntries` prunes
 * any previously-synced size this call doesn't return (a real sync, not an
 * additive-only one) — see its own doc comment for why that matters here
 * specifically: a size whose architecture/generation/retirement status
 * changes, or one synced before `vcpus`/`memoryGb`/`architecture` existed as
 * columns, used to linger forever with blank spec data instead of either
 * having real data or not being offered at all. */
export const syncAzureSizes = (): Effect.Effect<
  ReadonlyArray<CatalogEntry>,
  CloudCatalogError | AzureNotConfiguredError,
  Db
> =>
  Effect.gen(function* () {
    const { client } = yield* getComputeClient();
    const location = config.azureMachinesLocation;
    if (!location) {
      return yield* Effect.fail(locationNotConfiguredError());
    }
    const skus = yield* Effect.tryPromise({
      try: async () => {
        const results = [];
        const options = { filter: `location eq '${location}'` };
        for await (const sku of client.resourceSkus.list(options)) {
          results.push(sku);
        }
        return results;
      },
      catch: (cause) => new CloudCatalogError({ reason: "list_resource_skus_failed", cause }),
    });

    const seen = new Set<string>();
    const entries: CatalogEntry[] = [];
    for (const sku of skus) {
      if (sku.resourceType !== "virtualMachines" || !sku.name || seen.has(sku.name)) continue;
      if (
        !isGen2Capable(sku) ||
        isScheduledForRetirement(sku) ||
        isRestrictedInLocation(sku, location)
      ) {
        continue;
      }
      const architecture = stringCapability(sku, "CpuArchitectureType");
      if (!architecture || !isOfferedArchitecture(architecture)) continue;
      seen.add(sku.name);
      const vcpus = numericCapability(sku, "vCPUs");
      const memoryGb = numericCapability(sku, "MemoryGB");
      entries.push({
        code: sku.name,
        displayName: skuDisplayName(sku),
        ...(vcpus !== undefined ? { vcpus } : {}),
        ...(memoryGb !== undefined ? { memoryGb } : {}),
        architecture,
      });
    }

    yield* upsertEntries("azure", "sku", entries);
    return entries;
  });

/** No live Azure API to sync images from (see this file's header comment) —
 * seeds the catalog from the same `UBUNTU_IMAGES` map the real adapter
 * resolves images against, so the catalog can never drift ahead of what the
 * adapter would actually accept. Safe to call repeatedly (idempotent
 * upsert); called once at boot rather than on a schedule, since the map only
 * changes when someone edits and redeploys the code. */
const azureImageEntries: CatalogEntry[] = Object.entries(UBUNTU_IMAGES).map(([code, image]) => ({
  code,
  displayName: code,
  architecture: image.architecture,
}));

export const seedAzureImages = (): Effect.Effect<
  ReadonlyArray<CatalogEntry>,
  CloudCatalogError,
  Db
> => upsertEntries("azure", "image", azureImageEntries).pipe(Effect.as(azureImageEntries));

/** The full synced catalog for one provider/kind — no org filtering (there
 * is none anymore, see `provider-catalog.ts`'s doc comment). Backs the
 * catalog list endpoint the Add Machine form reads directly, with real
 * vcpus/memoryGb/architecture data so it can compute compatibility itself
 * instead of trusting a maintained allow-list. */
export const listProviderCatalog = (
  provider: "azure",
  kind: CatalogKind,
): Effect.Effect<ReadonlyArray<CatalogEntry>, CloudCatalogError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            code: providerCatalogEntries.code,
            displayName: providerCatalogEntries.displayName,
            vcpus: providerCatalogEntries.vcpus,
            memoryGb: providerCatalogEntries.memoryGb,
            architecture: providerCatalogEntries.architecture,
          })
          .from(providerCatalogEntries)
          .where(
            and(
              eq(providerCatalogEntries.provider, provider),
              eq(providerCatalogEntries.kind, kind),
            ),
          ),
      catch: (cause) => new CloudCatalogError({ reason: "list_failed", cause }),
    });
    return rows.map((row) => ({
      code: row.code,
      displayName: row.displayName,
      ...(row.vcpus !== null ? { vcpus: row.vcpus } : {}),
      ...(row.memoryGb !== null ? { memoryGb: row.memoryGb } : {}),
      ...(row.architecture !== null ? { architecture: row.architecture } : {}),
    }));
  });

/** Single-row lookup by code — used by `MachineService.create` to confirm a
 * chosen size actually exists in the synced catalog and read its
 * architecture for the compatibility check against the chosen image.
 * Returns `null` rather than failing when nothing matches — "unknown size"
 * is the caller's validation error to raise, not this function's. */
export const getCatalogEntry = (
  provider: "azure",
  kind: CatalogKind,
  code: string,
): Effect.Effect<CatalogEntry | null, CloudCatalogError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            code: providerCatalogEntries.code,
            displayName: providerCatalogEntries.displayName,
            vcpus: providerCatalogEntries.vcpus,
            memoryGb: providerCatalogEntries.memoryGb,
            architecture: providerCatalogEntries.architecture,
          })
          .from(providerCatalogEntries)
          .where(
            and(
              eq(providerCatalogEntries.provider, provider),
              eq(providerCatalogEntries.kind, kind),
              eq(providerCatalogEntries.code, code),
            ),
          )
          .limit(1),
      catch: (cause) => new CloudCatalogError({ reason: "get_entry_failed", cause }),
    });
    const row = rows[0];
    if (!row) return null;
    return {
      code: row.code,
      displayName: row.displayName,
      ...(row.vcpus !== null ? { vcpus: row.vcpus } : {}),
      ...(row.memoryGb !== null ? { memoryGb: row.memoryGb } : {}),
      ...(row.architecture !== null ? { architecture: row.architecture } : {}),
    };
  });
