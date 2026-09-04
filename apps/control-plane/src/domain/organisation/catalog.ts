import type { OrgEvent } from "@cloudable/events";
import { orgCatalogSelections, providerCatalogEntries } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import type { CatalogKind } from "../../services/CloudCatalogService";
import { EventBus } from "../../services/EventBus";

/**
 * An org's curated allow-list over the global `providerCatalogEntries`
 * reference data — see `packages/schema/src/tables/provider-catalog.ts`'s
 * own header comment. Only Azure has a real catalog today
 * (`PROVIDER_CAPABILITIES` in the console/contracts layer); this module is
 * provider-generic so a future provider's catalog needs no schema change.
 */

// `Schema.TaggedError`, not `Data.TaggedError` — same convention as
// `OrgSettingsError`/`OrgPackagesError`: `reason: "unknown_catalog_entry"` is
// a genuine client-facing validation failure that crosses the HTTP boundary
// via `.addError()`; every other reason is our own infra breaking
// (`Effect.die`'d in the handler instead, see `rethrowInfraAsDefect` there).
export class OrgCatalogError extends Schema.TaggedError<OrgCatalogError>()("OrgCatalogError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface CatalogListItem {
  code: string;
  displayName: string;
  enabled: boolean;
}

/** Discovered entries joined against this org's enabled subset — what the
 * Integrations page's catalog checklist renders. */
export const listOrgCatalog = (
  orgId: string,
  provider: "azure",
  kind: CatalogKind,
): Effect.Effect<ReadonlyArray<CatalogListItem>, OrgCatalogError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [discovered, enabled] = yield* Effect.all([
      Effect.tryPromise({
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
        catch: (cause) => new OrgCatalogError({ reason: "read_discovered_failed", cause }),
      }),
      Effect.tryPromise({
        try: () =>
          db
            .select({ code: orgCatalogSelections.code })
            .from(orgCatalogSelections)
            .where(
              and(
                eq(orgCatalogSelections.orgId, orgId),
                eq(orgCatalogSelections.provider, provider),
                eq(orgCatalogSelections.kind, kind),
              ),
            ),
        catch: (cause) => new OrgCatalogError({ reason: "read_enabled_failed", cause }),
      }),
    ]);
    const enabledCodes = new Set(enabled.map((row) => row.code));
    return discovered
      .map((entry) => ({ ...entry, enabled: enabledCodes.has(entry.code) }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  });

/** Whether `code` is in this org's enabled subset for `provider`/`kind` —
 * the real enforcement behind the machine-creation dropdown, called from
 * `MachineService.create` so a raw API call can't send an uncataloged value
 * just because the UI only ever offers enabled ones. */
export const isCatalogEntryEnabled = (
  orgId: string,
  provider: "azure",
  kind: CatalogKind,
  code: string,
): Effect.Effect<boolean, OrgCatalogError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ code: orgCatalogSelections.code })
          .from(orgCatalogSelections)
          .where(
            and(
              eq(orgCatalogSelections.orgId, orgId),
              eq(orgCatalogSelections.provider, provider),
              eq(orgCatalogSelections.kind, kind),
              eq(orgCatalogSelections.code, code),
            ),
          )
          .limit(1),
      catch: (cause) => new OrgCatalogError({ reason: "read_enabled_failed", cause }),
    });
    return rows.length > 0;
  });

export interface ToggleCatalogEntryInput {
  orgId: string;
  provider: "azure";
  kind: CatalogKind;
  code: string;
  displayName: string;
  enabled: boolean;
  actorType: "person" | "system";
  actorId: string;
}

/** Namespaced so `org.setting_changed`'s generic `key` never collides with
 * one of the org's other settings — same convention as
 * `domain/organisation/packages.ts`'s `orgPackageSettingKey`. */
export const catalogSettingKey = (provider: string, kind: CatalogKind, code: string): string =>
  `catalog:${provider}:${kind}:${code}`;

const PLACEHOLDER_ID = "";
const PLACEHOLDER_RECORDED_AT = new Date(0);

function catalogSettingChangedEvent(
  input: ToggleCatalogEntryInput,
  correlationId: string,
): OrgEvent {
  return {
    id: PLACEHOLDER_ID,
    type: "org.setting_changed",
    occurredAt: new Date(),
    recordedAt: PLACEHOLDER_RECORDED_AT,
    orgId: input.orgId,
    actorType: input.actorType,
    actorId: input.actorId,
    machineId: null,
    correlationId,
    schemaVersion: 1,
    payload: {
      key: catalogSettingKey(input.provider, input.kind, input.code),
      previous: input.enabled ? null : { displayName: input.displayName },
      current: input.enabled ? { displayName: input.displayName } : null,
      level: "org",
    },
  };
}

/** Enables or disables one catalog entry for an org — an add/remove against
 * `orgCatalogSelections`, same "set of independently addable/removable
 * entries" shape as the org package manifest
 * (`domain/organisation/packages.ts`). */
export const toggleOrgCatalogEntry = (
  input: ToggleCatalogEntryInput,
): Effect.Effect<void, OrgCatalogError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;

    if (input.enabled) {
      const discovered = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ code: providerCatalogEntries.code })
            .from(providerCatalogEntries)
            .where(
              and(
                eq(providerCatalogEntries.provider, input.provider),
                eq(providerCatalogEntries.kind, input.kind),
                eq(providerCatalogEntries.code, input.code),
              ),
            )
            .limit(1),
        catch: (cause) => new OrgCatalogError({ reason: "read_discovered_failed", cause }),
      });
      if (discovered.length === 0) {
        // Enabling a code that was never discovered (synced from Azure, or
        // seeded from UBUNTU_IMAGES) would silently succeed but never
        // appear in `listOrgCatalog` — and, worse, would still pass
        // `isCatalogEntryEnabled`'s check, letting a raw API call put an
        // unvalidated region/image on a real machine. Reject it instead.
        return yield* Effect.fail(
          new OrgCatalogError({ reason: "unknown_catalog_entry", cause: input.code }),
        );
      }
    }

    yield* Effect.tryPromise({
      try: async () => {
        if (input.enabled) {
          await db
            .insert(orgCatalogSelections)
            .values({
              orgId: input.orgId,
              provider: input.provider,
              kind: input.kind,
              code: input.code,
            })
            .onConflictDoNothing();
        } else {
          await db
            .delete(orgCatalogSelections)
            .where(
              and(
                eq(orgCatalogSelections.orgId, input.orgId),
                eq(orgCatalogSelections.provider, input.provider),
                eq(orgCatalogSelections.kind, input.kind),
                eq(orgCatalogSelections.code, input.code),
              ),
            );
        }
      },
      catch: (cause) => new OrgCatalogError({ reason: "write_failed", cause }),
    });

    yield* eventBus
      .publish([catalogSettingChangedEvent(input, ulid())])
      .pipe(
        Effect.mapError((cause) => new OrgCatalogError({ reason: "event_publish_failed", cause })),
      );
  });
