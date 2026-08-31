import type { DomainEvent } from "@cloudable/events";
import type * as schema from "@cloudable/schema";
import { events, settingValues } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Data, Effect } from "effect";
import { ulid } from "ulid";

type DbHandle = PostgresJsDatabase<typeof schema>;

/**
 * Logging tier and retention location (spec §17).
 *
 * Both are stored as ordinary rows in the existing `settingValues` table
 * (org → template → machine chain, `resolveSetting`'s pattern — see
 * `@cloudable/schema`) rather than a dedicated table: the resolution
 * mechanism these two settings need already exists and is the single
 * source of truth for every other setting in the product, so a parallel
 * table would just be a second, divergence-prone place to look.
 *
 * Both are collapsed to org scope only, deliberately:
 *  - Logging tier is per-template policy, but the template layer is inert
 *    in v1 (CLAUDE.md "Not in v1"), so it is effectively per-org for now.
 *  - Retention location is explicitly a single org-wide value with NO
 *    per-machine override (spec §17: "single org-wide value, no
 *    per-machine setting... a DPA matter, not a toggle").
 *
 * The setters below take an `orgId` and nothing else — there is no
 * `scopeType`/`machineId` parameter to pass, so it is structurally
 * impossible to call these with a machine scope. If a settings API is
 * ever added on top of this, it must not expose a machine-scoped writer
 * for either key.
 */

export const LOGGING_TIER_KEY = "logging_tier";
export const RETENTION_LOCATION_KEY = "retention_location";

export type LoggingTier = 1 | 2 | 3;
export type RetentionLocation = "customer" | "cloudable_sweden_central";

/**
 * Default logging tier for an org that hasn't configured one yet.
 *
 * Tier 2 (session-level), not tier 3: tier 3 (full command capture) has a
 * stated consequence sold at purchase — Cloudable sits on the plaintext
 * path (spec §17) — and must be an explicit org decision, never a silent
 * default. Tier 1 alone would silently under-log relative to what most
 * orgs actually want out of the box.
 */
export const DEFAULT_LOGGING_TIER: LoggingTier = 2;

/**
 * Default residency for an org that hasn't configured one yet.
 *
 * "customer" (the customer's own store), not Cloudable-held: residency
 * changes are a DPA matter (spec §17), so Cloudable never defaults an org
 * into Cloudable-held storage on their behalf.
 */
export const DEFAULT_RETENTION_LOCATION: RetentionLocation = "customer";

export class LoggingSettingsError extends Data.TaggedError("LoggingSettingsError")<{
  reason: string;
  cause?: unknown;
}> {}

/** Who/what is making a settings change, for the `org.setting_changed` event it produces. */
export interface SettingChangeActor {
  actorType: DomainEvent["actorType"];
  actorId: string;
  correlationId?: string;
}

const readOrgSetting = <T>(
  db: DbHandle,
  orgId: string,
  key: string,
): Effect.Effect<T | undefined, LoggingSettingsError> =>
  Effect.tryPromise({
    try: async () => {
      const rows = await db
        .select({ value: settingValues.value })
        .from(settingValues)
        .where(
          and(
            eq(settingValues.scopeType, "org"),
            eq(settingValues.scopeId, orgId),
            eq(settingValues.key, key),
          ),
        )
        .limit(1);
      return rows[0]?.value as T | undefined;
    },
    catch: (cause) => new LoggingSettingsError({ reason: "read_failed", cause }),
  });

/** The org's configured logging tier, or `DEFAULT_LOGGING_TIER` if unset. */
export const getOrgLoggingTier = (
  db: DbHandle,
  orgId: string,
): Effect.Effect<LoggingTier, LoggingSettingsError> =>
  Effect.map(
    readOrgSetting<LoggingTier>(db, orgId, LOGGING_TIER_KEY),
    (value) => value ?? DEFAULT_LOGGING_TIER,
  );

/** The org's configured retention location, or `DEFAULT_RETENTION_LOCATION` if unset. */
export const getOrgRetentionLocation = (
  db: DbHandle,
  orgId: string,
): Effect.Effect<RetentionLocation, LoggingSettingsError> =>
  Effect.map(
    readOrgSetting<RetentionLocation>(db, orgId, RETENTION_LOCATION_KEY),
    (value) => value ?? DEFAULT_RETENTION_LOCATION,
  );

/**
 * Writes the setting row and records an `org.setting_changed` event in the
 * same transaction — `org.setting_changed` is tier 1 (`EVENT_METADATA`:
 * "an org- or machine-level default setting was changed"), the compliance
 * floor, so it is always recorded regardless of the org's own logging-tier
 * configuration.
 *
 * This inserts directly into the `events` table rather than routing
 * through `EventBus.publish`: `EventBus.publish` exists to make the
 * tier-2/3 filtering decision (spec §17), which is moot for a tier-1 event
 * that is never dropped, and going through it here would create a circular
 * import (`EventBus.publish` itself depends on this module via
 * `../logging/tier-filter`).
 *
 * The delete-then-insert against `setting_values` and the event insert are
 * one transaction: a mid-write crash cannot leave the setting changed with
 * no record of the change, or vice versa.
 */
const writeOrgSettingAndRecord = (
  db: DbHandle,
  orgId: string,
  key: string,
  previous: unknown,
  current: unknown,
  actor: SettingChangeActor,
): Effect.Effect<void, LoggingSettingsError> =>
  Effect.tryPromise({
    try: () =>
      db.transaction(async (tx) => {
        await tx
          .delete(settingValues)
          .where(
            and(
              eq(settingValues.scopeType, "org"),
              eq(settingValues.scopeId, orgId),
              eq(settingValues.key, key),
            ),
          );
        await tx.insert(settingValues).values({
          scopeType: "org",
          scopeId: orgId,
          key,
          value: current,
          source: "org",
        });
        await tx.insert(events).values({
          id: ulid(),
          type: "org.setting_changed",
          occurredAt: new Date(),
          recordedAt: new Date(),
          orgId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          machineId: null,
          correlationId: actor.correlationId ?? crypto.randomUUID(),
          schemaVersion: 1,
          payload: { key, previous, current, level: "org" },
        });
      }),
    catch: (cause) => new LoggingSettingsError({ reason: "write_failed", cause }),
  });

/**
 * NOT the write path behind `PATCH /api/v1/organisation` — that endpoint
 * (`domain/organisation/settings.ts`'s `updateOrgSettings`) writes this same
 * key through `applySettingChange` (`domain/config/apply-setting-change.ts`)
 * instead, to go through the one shared write+event path every other
 * setting in the product uses (docs/spec.md §16). This setter's own
 * transactional write+event (`writeOrgSettingAndRecord`, above) is kept
 * for any lower-level caller that genuinely needs the atomicity guarantee
 * — none does today outside this file's own test — but a new caller
 * should reach for `applySettingChange` first unless it specifically needs
 * that guarantee, so this doesn't quietly become a second, diverging write
 * path for the same key.
 */
export const setOrgLoggingTier = (
  db: DbHandle,
  orgId: string,
  tier: LoggingTier,
  actor: SettingChangeActor,
): Effect.Effect<void, LoggingSettingsError> =>
  Effect.gen(function* () {
    const previous = yield* getOrgLoggingTier(db, orgId);
    yield* writeOrgSettingAndRecord(db, orgId, LOGGING_TIER_KEY, previous, tier, actor);
  });

/** See `setOrgLoggingTier`'s doc comment — same caveat, same key-owning endpoint. */
export const setOrgRetentionLocation = (
  db: DbHandle,
  orgId: string,
  location: RetentionLocation,
  actor: SettingChangeActor,
): Effect.Effect<void, LoggingSettingsError> =>
  Effect.gen(function* () {
    const previous = yield* getOrgRetentionLocation(db, orgId);
    yield* writeOrgSettingAndRecord(db, orgId, RETENTION_LOCATION_KEY, previous, location, actor);
  });
