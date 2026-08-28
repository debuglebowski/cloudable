import type { DomainEvent } from "@cloudable/events";
import { EVENT_METADATA } from "@cloudable/events";
import type * as schema from "@cloudable/schema";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import {
  DEFAULT_LOGGING_TIER,
  type LoggingSettingsError,
  type LoggingTier,
  getOrgLoggingTier,
} from "./settings";

type DbHandle = PostgresJsDatabase<typeof schema>;

/**
 * Filters a batch of events against each event's org's configured logging
 * tier (spec §17). Tier-1 events are the compliance floor and are never
 * dropped, regardless of configuration. A tier-2/3 event is dropped when
 * the org's configured tier is below that event's minimum tier.
 *
 * `EventBus.publish` is the sole caller — every other unit calls
 * `EventBus.publish` directly, so filtering lives here, inside publish's
 * own implementation, rather than as a parallel path callers would need to
 * adopt.
 *
 * A publish batch is typically single-org, but this groups by `orgId` and
 * looks up each distinct org's tier exactly once, so a multi-org batch
 * (should one ever occur) stays correct without a lookup per event.
 */
export const filterByLoggingTier = (
  db: DbHandle,
  batch: ReadonlyArray<DomainEvent>,
): Effect.Effect<ReadonlyArray<DomainEvent>, LoggingSettingsError> =>
  Effect.gen(function* () {
    const orgIds = [...new Set(batch.map((event) => event.orgId))];
    const tierByOrg = new Map<string, LoggingTier>();
    for (const orgId of orgIds) {
      tierByOrg.set(orgId, yield* getOrgLoggingTier(db, orgId));
    }

    return batch.filter((event) => {
      const { tier } = EVENT_METADATA[event.type];
      if (tier === 1) return true;
      return (tierByOrg.get(event.orgId) ?? DEFAULT_LOGGING_TIER) >= tier;
    });
  });
