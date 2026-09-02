import type { DomainEvent } from "@cloudable/events";
import { EVENT_METADATA } from "@cloudable/events";
import type * as schema from "@cloudable/schema";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import {
  DEFAULT_LOGGING_TIER,
  LOGGING_TIER_KEY,
  type LoggingSettingsError,
  type LoggingTier,
  getEffectiveLoggingTier,
  getOrgLoggingTier,
} from "./settings";

type DbHandle = PostgresJsDatabase<typeof schema>;

/**
 * Filters a batch of events against each event's *effective* configured
 * logging tier. Tier-1 events are the compliance floor and are
 * never dropped, regardless of configuration. A tier-2/3 event is dropped
 * when the effective tier is below that event's minimum tier.
 *
 * A batch with no tier-2/3 event at all (the common case — e.g. a plain
 * `machine.created` + `machine.owner_assigned` pair) short-circuits before
 * any tier lookup, so it never touches the DB for this at all.
 *
 * "Effective" means: a machine-scoped event (`event.machineId` set) is
 * checked against that specific machine's resolved tier — its own
 * machine-level override if it has one, else the org default
 * (`getEffectiveLoggingTier`, the org → machine chain every other setting
 * resolves through). An org-scoped event (`event.machineId` is `null`) is
 * checked against the plain org default (`getOrgLoggingTier`) — there is
 * no machine to resolve a chain against. Every tier-2/3 event type in the
 * catalogue today happens to carry a `machineId` (see
 * `packages/events/src/metadata.ts`), but this still resolves the org path
 * defensively in case a future org-scoped event is ever given tier > 1.
 *
 * One exception: a `machine.setting_changed` event that itself records a
 * change to `logging_tier` is never dropped, regardless of the tier it
 * would otherwise be checked against. Without this, lowering a machine's
 * own tier could erase the audit trail of that exact change — by the time
 * this filter runs, `applySettingChange` has already committed the new,
 * lower tier, so the event recording the downgrade would be judged against
 * the tier it just set, and silently vanish. Org-scope changes to this key
 * don't need the exception: `org.setting_changed` is already tier 1.
 *
 * `EventBus.publish` is the sole caller — every other unit calls
 * `EventBus.publish` directly, so filtering lives here, inside publish's
 * own implementation, rather than as a parallel path callers would need to
 * adopt.
 *
 * A publish batch is typically single-org/single-machine, but this groups
 * by distinct `orgId` and `machineId` and looks up each exactly once, so a
 * larger batch (should one ever occur) stays correct without a lookup per
 * event.
 */
export const filterByLoggingTier = (
  db: DbHandle,
  batch: ReadonlyArray<DomainEvent>,
): Effect.Effect<ReadonlyArray<DomainEvent>, LoggingSettingsError> =>
  Effect.gen(function* () {
    const isNeverDropped = (event: DomainEvent) =>
      EVENT_METADATA[event.type].tier === 1 ||
      (event.type === "machine.setting_changed" && event.payload.key === LOGGING_TIER_KEY);

    const gated = batch.filter((event) => !isNeverDropped(event));
    if (gated.length === 0) return batch;

    const orgIds = [...new Set(gated.map((event) => event.orgId))];
    const orgTierByOrg = new Map<string, LoggingTier>();
    for (const orgId of orgIds) {
      orgTierByOrg.set(orgId, yield* getOrgLoggingTier(db, orgId));
    }

    const machineOrgPairs = new Map<string, string>();
    for (const event of gated) {
      if (event.machineId && !machineOrgPairs.has(event.machineId)) {
        machineOrgPairs.set(event.machineId, event.orgId);
      }
    }
    const tierByMachine = new Map<string, LoggingTier>();
    for (const [machineId, orgId] of machineOrgPairs) {
      const resolved = yield* getEffectiveLoggingTier(db, { orgId, machineId });
      tierByMachine.set(machineId, resolved.tier);
    }

    return batch.filter((event) => {
      if (isNeverDropped(event)) return true;
      const { tier } = EVENT_METADATA[event.type];
      const effectiveTier = event.machineId
        ? tierByMachine.get(event.machineId)
        : orgTierByOrg.get(event.orgId);
      return (effectiveTier ?? DEFAULT_LOGGING_TIER) >= tier;
    });
  });
