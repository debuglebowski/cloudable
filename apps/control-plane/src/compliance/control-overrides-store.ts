import { controlOverrides } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { Db } from "../db/layer";
import { type ControlOverride, type ControlStatus, OVERRIDABLE_CONTROL_IDS } from "./control-map";

/**
 * DB/infra failure — same convention as `finding-store.ts`'s
 * `FindingStoreError`: never a meaningful outcome for an HTTP caller, so
 * handlers `Effect.die` this rather than surface it over the wire.
 */
export class ControlOverrideStoreError extends Data.TaggedError("ControlOverrideStoreError")<{
  reason: string;
  cause?: unknown;
}> {}

/**
 * A genuine client-facing validation failure — `controlId` isn't overridable: either it
 * doesn't exist at all, or it's one of Cloudable's structurally out-of-scope controls
 * (`OVERRIDABLE_CONTROL_IDS` in `control-map.ts` excludes those on purpose).
 * `Schema.TaggedError`, not `Data.TaggedError` — this one DOES travel over HTTP via
 * `.addError()` (same reasoning as `OrgSettingsError` in `domain/organisation/settings.ts`).
 */
export class UnknownControlError extends Schema.TaggedError<UnknownControlError>()(
  "UnknownControlError",
  { controlId: Schema.String },
) {}

/** Shared guard for both write paths below — one place enforcing "only a known,
 * overridable control id may be written or cleared", so a future change to that rule
 * (e.g. tightening or loosening which controls are eligible) can't update one call site
 * and miss the other. */
const ensureOverridable = (controlId: string): Effect.Effect<void, UnknownControlError> =>
  OVERRIDABLE_CONTROL_IDS.has(controlId)
    ? Effect.void
    : Effect.fail(new UnknownControlError({ controlId }));

/** Every override this org has explicitly set, keyed by control id. Absence of a row for
 * a given control means "use the computed default" — never "not_covered" by implication. */
export const loadControlOverrides = (
  orgId: string,
): Effect.Effect<ControlOverride[], ControlOverrideStoreError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ controlId: controlOverrides.controlId, status: controlOverrides.status })
          .from(controlOverrides)
          .where(eq(controlOverrides.orgId, orgId)),
      catch: (cause) => new ControlOverrideStoreError({ reason: "load_failed", cause }),
    });
    return rows.map((row) => ({ controlId: row.controlId, status: row.status as ControlStatus }));
  });

/**
 * Sets (or replaces) this org's override for one control — a single upsert on the
 * (orgId, controlId) unique index, so setting it twice updates in place rather than
 * accumulating history; this is live policy, not an event log.
 */
export const setControlOverride = (
  orgId: string,
  controlId: string,
  status: ControlStatus,
): Effect.Effect<void, ControlOverrideStoreError | UnknownControlError, Db> =>
  Effect.gen(function* () {
    yield* ensureOverridable(controlId);
    const db = yield* Db;
    yield* Effect.tryPromise({
      try: () =>
        db
          .insert(controlOverrides)
          .values({ orgId, controlId, status })
          .onConflictDoUpdate({
            target: [controlOverrides.orgId, controlOverrides.controlId],
            set: { status, updatedAt: new Date() },
          }),
      catch: (cause) => new ControlOverrideStoreError({ reason: "set_failed", cause }),
    });
  });

/** Clears this org's override for one control, reverting it to the computed default. */
export const clearControlOverride = (
  orgId: string,
  controlId: string,
): Effect.Effect<void, ControlOverrideStoreError | UnknownControlError, Db> =>
  Effect.gen(function* () {
    yield* ensureOverridable(controlId);
    const db = yield* Db;
    yield* Effect.tryPromise({
      try: () =>
        db
          .delete(controlOverrides)
          .where(and(eq(controlOverrides.orgId, orgId), eq(controlOverrides.controlId, controlId))),
      catch: (cause) => new ControlOverrideStoreError({ reason: "clear_failed", cause }),
    });
  });
