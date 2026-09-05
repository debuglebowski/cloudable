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
import { and, eq } from "drizzle-orm";
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
}

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
          for (const entry of entries) {
            await tx
              .insert(providerCatalogEntries)
              .values({ provider, kind, code: entry.code, displayName: entry.displayName })
              .onConflictDoUpdate({
                target: [
                  providerCatalogEntries.provider,
                  providerCatalogEntries.kind,
                  providerCatalogEntries.code,
                ],
                set: { displayName: entry.displayName, syncedAt: new Date() },
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
 * Upserts into `providerCatalogEntries`; never removes a previously-synced
 * region that Azure stops listing (an org that already enabled it keeps its
 * choice — pure additive sync, no destructive reconciliation here). */
export const syncAzureRegions = (): Effect.Effect<
  ReadonlyArray<CatalogEntry>,
  CloudCatalogError | AzureNotConfiguredError,
  Db
> =>
  Effect.gen(function* () {
    const { client, subscriptionId } = yield* getSubscriptionClient();
    const locations = yield* Effect.tryPromise({
      try: async () => {
        const results = [];
        for await (const location of client.subscriptions.listLocations(subscriptionId)) {
          results.push(location);
        }
        return results;
      },
      catch: (cause) => new CloudCatalogError({ reason: "list_locations_failed", cause }),
    });

    const entries: CatalogEntry[] = locations
      .filter((location): location is typeof location & { name: string } => Boolean(location.name))
      .map((location) => ({
        code: location.name,
        displayName: location.displayName ?? location.name,
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

/** Real Azure SDK call — `ComputeManagementClient.resourceSkus.list()`
 * enumerates every SKU (VM sizes, disks, etc.) available to the configured
 * subscription; filtered to `resourceType === "virtualMachines"` for just
 * the VM sizes a machine's `sizeSku` actually names. Subscription-wide, not
 * per-region (same shape as `syncAzureRegions` — a real size's availability
 * does vary by region in Azure, but this catalog doesn't model that nuance
 * any more than `syncAzureRegions` models per-size availability; an org
 * enabling a size that turns out to be absent in its chosen region still
 * fails at actual provisioning time, just not at this earlier catalog-check
 * step). Same additive-only upsert as regions — never removes a
 * previously-synced size Azure stops listing. */
export const syncAzureSizes = (): Effect.Effect<
  ReadonlyArray<CatalogEntry>,
  CloudCatalogError | AzureNotConfiguredError,
  Db
> =>
  Effect.gen(function* () {
    const { client } = yield* getComputeClient();
    const skus = yield* Effect.tryPromise({
      try: async () => {
        const results = [];
        for await (const sku of client.resourceSkus.list()) {
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
      seen.add(sku.name);
      entries.push({ code: sku.name, displayName: sku.name });
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
