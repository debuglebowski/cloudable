import { machines, orgs, settingValues } from "@cloudable/schema";
import { and, count, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Db } from "../../db/layer";
import {
  DEFAULT_LOGGING_TIER,
  DEFAULT_RETENTION_LOCATION,
  LOGGING_TIER_KEY,
  type LoggingTier,
  RETENTION_LOCATION_KEY,
  type RetentionLocation,
  type SettingChangeActor,
  setOrgLoggingTier,
  setOrgRetentionLocation,
} from "../../logging/settings";
import { DEFAULT_APPROVAL_MODE, settingKeyFor } from "../../services/ApprovalService";
import { DEFAULT_RETENTION_DAYS, RETENTION_DAYS_KEY } from "../archive/org-policy";

/**
 * Aggregate read/write for the Organisation page (spec §20's "Organisation"
 * settings: approval mode per action type, logging tier, retention default
 * and location). Every one of these settings ALREADY has a real, correct
 * home — `logging/settings.ts` (tier/residency), `ApprovalService.ts`
 * (per-action-type approval mode), `domain/archive/org-policy.ts` (default
 * retention days) — built by the units that actually consume each value.
 * This module is deliberately thin: it reads/writes the exact same
 * `settingValues` rows those modules do, using their exported key
 * constants, rather than inventing a second, parallel settings store for
 * the console to read from. Only `orgs.name` is a real table column
 * (there's no "org name setting").
 */

// Schema.TaggedError, not Data.TaggedError — the client-facing validation
// reasons (see VALIDATION_REASONS in http/handlers/organisation.ts) travel
// over HTTP via `.addError()`; infra-failure reasons never do (Effect.die'd
// in the handler instead), so `cause` never needs to actually serialize.
export class OrgSettingsError extends Schema.TaggedError<OrgSettingsError>()("OrgSettingsError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export type ApprovalActionType =
  | "snapshot_restore"
  | "break_glass"
  | "admin_access"
  | "offboarding";
export type ApprovalMode = "none" | "single" | "dual";

const APPROVAL_ACTION_TYPES: readonly ApprovalActionType[] = [
  "snapshot_restore",
  "break_glass",
  "admin_access",
  "offboarding",
];

export interface OrgSettingsView {
  id: string;
  name: string;
  approvalModes: Record<ApprovalActionType, ApprovalMode>;
  loggingTier: LoggingTier;
  /** How many of this org's machines have their own machine-level logging-tier override (spec §17). Purely informational — the org page has nothing to do about a machine's override besides know it exists; see the machine detail page for the actual override control. */
  loggingTierOverrideCount: number;
  retentionDefaultDays: number;
  retentionLocation: RetentionLocation;
}

const dbTry = <A>(thunk: () => Promise<A>, reason: string): Effect.Effect<A, OrgSettingsError> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => new OrgSettingsError({ reason, cause }) });

const readOrgScopedSetting = <T>(
  orgId: string,
  key: string,
): Effect.Effect<T | undefined, OrgSettingsError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* dbTry(
      () =>
        db
          .select({ value: settingValues.value })
          .from(settingValues)
          .where(
            and(
              eq(settingValues.scopeType, "org"),
              eq(settingValues.scopeId, orgId),
              eq(settingValues.key, key),
            ),
          )
          .limit(1),
      "read_setting_failed",
    );
    return rows[0]?.value as T | undefined;
  });

export const getOrgSettings = (
  orgId: string,
): Effect.Effect<OrgSettingsView, OrgSettingsError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const orgRows = yield* dbTry(
      () => db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1),
      "read_org_failed",
    );
    const org = orgRows[0];
    if (!org) return yield* Effect.fail(new OrgSettingsError({ reason: "org_not_found" }));

    const approvalModeEntries = yield* Effect.all(
      APPROVAL_ACTION_TYPES.map((actionType) =>
        readOrgScopedSetting<ApprovalMode>(orgId, settingKeyFor(actionType)).pipe(
          Effect.map((value) => [actionType, value ?? DEFAULT_APPROVAL_MODE] as const),
        ),
      ),
    );

    const loggingTier =
      (yield* readOrgScopedSetting<LoggingTier>(orgId, LOGGING_TIER_KEY)) ?? DEFAULT_LOGGING_TIER;
    // A SQL count, not the rows themselves — this page only needs to know
    // that divergence exists (docs/frontend.md's LineageGutter "N machines
    // override this"), not which machines, and an org with many machines
    // shouldn't pull one row per override over the wire just to count
    // them. Joins through `machines` since a `settingValues` machine-scope
    // row's `scopeId` is the machine id, not the org id — there's no other
    // way to constrain it to this org.
    const loggingTierOverrideRows = yield* dbTry(
      () =>
        db
          .select({ count: count() })
          .from(settingValues)
          .innerJoin(machines, eq(machines.id, settingValues.scopeId))
          .where(
            and(
              eq(settingValues.scopeType, "machine"),
              eq(settingValues.key, LOGGING_TIER_KEY),
              eq(machines.orgId, orgId),
            ),
          ),
      "read_setting_failed",
    );
    const loggingTierOverrideCount = loggingTierOverrideRows[0]?.count ?? 0;
    const retentionDefaultDays =
      (yield* readOrgScopedSetting<number>(orgId, RETENTION_DAYS_KEY)) ?? DEFAULT_RETENTION_DAYS;
    const retentionLocation =
      (yield* readOrgScopedSetting<RetentionLocation>(orgId, RETENTION_LOCATION_KEY)) ??
      DEFAULT_RETENTION_LOCATION;

    return {
      id: org.id,
      name: org.name,
      approvalModes: Object.fromEntries(approvalModeEntries) as Record<
        ApprovalActionType,
        ApprovalMode
      >,
      loggingTier,
      loggingTierOverrideCount,
      retentionDefaultDays,
      retentionLocation,
    };
  });

export interface UpdateOrgSettingsInput {
  orgId: string;
  name?: string | undefined;
  approvalModes?: { [K in ApprovalActionType]?: ApprovalMode | undefined } | undefined;
  loggingTier?: LoggingTier | undefined;
  retentionDefaultDays?: number | undefined;
  retentionLocation?: RetentionLocation | undefined;
  actor: SettingChangeActor;
}

const writeOrgScopedSetting = (
  orgId: string,
  key: string,
  value: unknown,
): Effect.Effect<void, OrgSettingsError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* dbTry(
      () =>
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
          await tx
            .insert(settingValues)
            .values({ scopeType: "org", scopeId: orgId, key, value, source: "org" });
        }),
      "write_setting_failed",
    );
  });

/**
 * Every field is independently optional — the page sends one changed field
 * (or a handful) per save, not the whole settings object every time,
 * mirroring the generic config editor's own one-key-at-a-time model (spec
 * §16) even though this is a dedicated endpoint rather than routing through
 * `PATCH /api/v1/config/settings` (that endpoint's `key`/`value` shape
 * would need four separate calls for the four approval-mode entries alone,
 * and doesn't touch `orgs.name` at all since that's a table column, not a
 * setting — an aggregate endpoint here is a real simplification, not just
 * a shortcut).
 */
export const updateOrgSettings = (
  input: UpdateOrgSettingsInput,
): Effect.Effect<OrgSettingsView, OrgSettingsError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;

    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (trimmed.length === 0) {
        return yield* Effect.fail(new OrgSettingsError({ reason: "org_name_required" }));
      }
      yield* dbTry(
        () => db.update(orgs).set({ name: trimmed }).where(eq(orgs.id, input.orgId)),
        "write_org_name_failed",
      );
    }

    if (input.approvalModes) {
      for (const [actionType, mode] of Object.entries(input.approvalModes)) {
        if (!mode) continue;
        yield* writeOrgScopedSetting(
          input.orgId,
          settingKeyFor(actionType as ApprovalActionType),
          mode,
        );
      }
    }

    if (input.loggingTier !== undefined) {
      yield* setOrgLoggingTier(db, input.orgId, input.loggingTier, input.actor).pipe(
        Effect.mapError((e) => new OrgSettingsError({ reason: e.reason, cause: e.cause })),
      );
    }

    if (input.retentionDefaultDays !== undefined) {
      if (!Number.isInteger(input.retentionDefaultDays) || input.retentionDefaultDays < 1) {
        return yield* Effect.fail(
          new OrgSettingsError({ reason: "retention_days_must_be_a_positive_integer" }),
        );
      }
      yield* writeOrgScopedSetting(input.orgId, RETENTION_DAYS_KEY, input.retentionDefaultDays);
    }

    if (input.retentionLocation !== undefined) {
      yield* setOrgRetentionLocation(db, input.orgId, input.retentionLocation, input.actor).pipe(
        Effect.mapError((e) => new OrgSettingsError({ reason: e.reason, cause: e.cause })),
      );
    }

    return yield* getOrgSettings(input.orgId);
  });
