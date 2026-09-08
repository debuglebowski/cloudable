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
import { and, eq, sql } from "drizzle-orm";
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

export type CatalogKind = "region" | "image" | "sku";

export interface CatalogEntry {
  code: string;
  displayName: string;
  /** Only ever set by `syncAzureSizes` — regions/images have no such
   * concept and leave these `undefined`, stored as `null`. */
  vcpus?: number;
  memoryGb?: number;
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

const upsertEntries = (
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
                  syncedAt: new Date(),
                },
              });
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
 * Filtered to `config.azureMachinesLocation` when set, same reasoning as
 * `syncAzureSizes` below: self-hosted mode has exactly one usable region —
 * wherever the machines vnet/subnet actually live — so offering the rest of
 * Azure's ~60 regions here isn't a convenience, it's a trap. Enabling any
 * other region in an org's catalog produces machines that are guaranteed to
 * fail provisioning (a NIC can't join a subnet outside its own region — seen
 * live: `InvalidResourceReference` on a machine created against a region the
 * vnet doesn't exist in). Falls back to the unfiltered, every-region list
 * only when the location isn't known (e.g. an older deploy that hasn't
 * picked up `AZURE_MACHINES_LOCATION` yet), matching `syncAzureSizes`'s own
 * fallback. Upserts into `providerCatalogEntries`; never removes a
 * previously-synced region that Azure stops listing (an org that already
 * enabled it keeps its choice — pure additive sync, no destructive
 * reconciliation here). */
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
 * falling back to the bare name above. */
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

/** Real Azure SDK call — `ComputeManagementClient.resourceSkus.list()`
 * enumerates every SKU (VM sizes, disks, etc.) available to the configured
 * subscription; filtered to `resourceType === "virtualMachines"` for just
 * the VM sizes a machine's `sizeSku` actually names.
 *
 * Filtered server-side to `config.azureMachinesLocation` when set (the one
 * region `AZURE_MACHINES_SUBNET_ID` actually lives in — self-hosted mode
 * has no other usable region, since machines always join that one fixed
 * subnet). This is a real, load-bearing fix, not an optimization: called
 * unfiltered against a real subscription, this API took over two minutes
 * (tens of thousands of raw per-region SKU records) — long enough that the
 * request got killed mid-flight and the container along with it. Filtered
 * to one region, a few seconds. Falls back to the slow, unfiltered,
 * subscription-wide call only when the location isn't known (e.g. an older
 * deploy that hasn't picked up `AZURE_MACHINES_LOCATION` yet). Same
 * additive-only upsert as regions — never removes a previously-synced size
 * Azure stops listing. */
export const syncAzureSizes = (): Effect.Effect<
  ReadonlyArray<CatalogEntry>,
  CloudCatalogError | AzureNotConfiguredError,
  Db
> =>
  Effect.gen(function* () {
    const { client } = yield* getComputeClient();
    const location = config.azureMachinesLocation;
    const skus = yield* Effect.tryPromise({
      try: async () => {
        const results = [];
        const options = location ? { filter: `location eq '${location}'` } : undefined;
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
      if (!isGen2Capable(sku) || isScheduledForRetirement(sku)) continue;
      seen.add(sku.name);
      const vcpus = numericCapability(sku, "vCPUs");
      const memoryGb = numericCapability(sku, "MemoryGB");
      entries.push({
        code: sku.name,
        displayName: skuDisplayName(sku),
        ...(vcpus !== undefined ? { vcpus } : {}),
        ...(memoryGb !== undefined ? { memoryGb } : {}),
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
export const seedAzureImages = (): Effect.Effect<
  ReadonlyArray<CatalogEntry>,
  CloudCatalogError,
  Db
> =>
  upsertEntries(
    "azure",
    "image",
    Object.keys(UBUNTU_IMAGES).map((code) => ({ code, displayName: code })),
  ).pipe(Effect.as(Object.keys(UBUNTU_IMAGES).map((code) => ({ code, displayName: code }))));

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
    return rows;
  });
