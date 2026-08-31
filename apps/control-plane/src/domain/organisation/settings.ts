import { orgs, settingValues } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import {
  DEFAULT_LOGGING_TIER,
  DEFAULT_RETENTION_LOCATION,
  LOGGING_TIER_KEY,
  type LoggingTier,
  RETENTION_LOCATION_KEY,
  type RetentionLocation,
  type SettingChangeActor,
} from "../../logging/settings";
import { DEFAULT_APPROVAL_MODE, settingKeyFor } from "../../services/ApprovalService";
import type { EventBus } from "../../services/EventBus";
import { DEFAULT_RETENTION_DAYS, RETENTION_DAYS_KEY } from "../archive/org-policy";
import { applySettingChange } from "../config/apply-setting-change";

/**
 * Aggregate read/write for the Organisation page (spec §20's "Organisation"
 * settings: approval mode per action type, logging tier, retention default
 * and location). Every one of these settings ALREADY has a real, correct
 * home — `logging/settings.ts` (tier/residency), `ApprovalService.ts`
 * (per-action-type approval mode), `domain/archive/org-policy.ts` (default
 * retention days) — built by the units that actually consume each value.
 * This module is deliberately thin: it reads the exact same `settingValues`
 * rows those modules do, using their exported key constants, rather than
 * inventing a second, parallel settings store for the console to read from.
 * Only `orgs.name` is a real table column (there's no "org name setting").
 *
 * Writes go through `applySettingChange` (`domain/config/apply-setting-change.ts`)
 * — the same single code path the UI-facing `PATCH /api/v1/config/settings`
 * and the Git-sourced `POST /api/v1/config/import` endpoints use (docs/spec.md
 * §16: "Same path whether the change came from the UI or a Git commit") —
 * rather than each duplicating its own settingValues upsert + event-emission
 * logic. `updateOrgSettings` shares one `correlationId` across every key it
 * changes in a single PATCH, matching the "one PATCH is one logical
 * operation" convention `http/handlers/config.ts` already uses.
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

/**
 * Wraps an `applySettingChange` call for one org-scoped key, mapping its
 * (settingValues-specific) error union onto this module's `OrgSettingsError`
 * so the HTTP handler's existing `rethrowInfraAsDefect` keeps working
 * unchanged. In practice only `SettingWriteError` (a DB/event-publish
 * failure) can occur here: `scopeType` is always `"org"` with `scopeId`
 * fixed to `orgId`, so `applySettingChange`'s `InvalidScopeError` and its
 * machine-only `MachineNotFoundError`/`PinnedSettingError` paths never
 * trigger.
 */
const writeOrgSetting = (
  orgId: string,
  key: string,
  value: unknown,
  actor: SettingChangeActor,
  correlationId: string,
): Effect.Effect<void, OrgSettingsError, Db | EventBus> =>
  Effect.asVoid(
    applySettingChange({
      orgId,
      scopeType: "org",
      scopeId: orgId,
      key,
      value,
      // `SettingChangeActor.actorType` is `DomainEvent["actorType"]`
      // (`"person" | "system" | "agent" | "idp"`) since `logging/settings.ts`
      // also serves agent-derived writes; this module's only caller
      // (`http/handlers/organisation.ts`) builds it from `ConfigActor`,
      // whose wire schema (`http/routes/organisation.ts`) restricts
      // `type` to `Schema.Literal("person", "system")` — the narrower
      // union `applySettingChange` itself accepts.
      actorType: actor.actorType as "person" | "system",
      actorId: actor.actorId,
      correlationId,
    }).pipe(
      Effect.mapError((cause) => new OrgSettingsError({ reason: "write_setting_failed", cause })),
    ),
  );

/**
 * Every field is independently optional — the page sends one changed field
 * (or a handful) per save, not the whole settings object every time,
 * mirroring the generic config editor's own one-key-at-a-time model (spec
 * §16) even though this is a dedicated endpoint rather than routing through
 * `PATCH /api/v1/config/settings` (that endpoint's `key`/`value` shape
 * would need four separate calls for the four approval-mode entries alone,
 * and doesn't touch `orgs.name` at all since that's a table column, not a
 * setting — an aggregate endpoint here is a real simplification, not just
 * a shortcut). Every changed key in one PATCH shares a single
 * `correlationId`, same as `handlePatchSetting`'s "one PATCH is one logical
 * operation" convention.
 */
export const updateOrgSettings = (
  input: UpdateOrgSettingsInput,
): Effect.Effect<OrgSettingsView, OrgSettingsError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const correlationId = ulid();

    // --- validate every field before writing any of them. Each field below
    // is written (and, now that writes go through `applySettingChange`,
    // audited via an `org.setting_changed` event) as soon as it's checked —
    // with N independently-optional fields in one PATCH, validating one
    // field at a time interleaved with writes would let an earlier field's
    // write and event permanently commit before a later field's validation
    // fails the whole request, leaving the client-visible error ("nothing
    // was applied") inconsistent with what the audit trail actually shows
    // was applied. Validating everything up front avoids that.
    const trimmedName = input.name?.trim();
    if (trimmedName !== undefined && trimmedName.length === 0) {
      return yield* Effect.fail(new OrgSettingsError({ reason: "org_name_required" }));
    }
    if (
      input.retentionDefaultDays !== undefined &&
      (!Number.isInteger(input.retentionDefaultDays) || input.retentionDefaultDays < 1)
    ) {
      return yield* Effect.fail(
        new OrgSettingsError({ reason: "retention_days_must_be_a_positive_integer" }),
      );
    }

    if (trimmedName !== undefined) {
      yield* dbTry(
        () => db.update(orgs).set({ name: trimmedName }).where(eq(orgs.id, input.orgId)),
        "write_org_name_failed",
      );
    }

    if (input.approvalModes) {
      for (const [actionType, mode] of Object.entries(input.approvalModes)) {
        if (!mode) continue;
        yield* writeOrgSetting(
          input.orgId,
          settingKeyFor(actionType as ApprovalActionType),
          mode,
          input.actor,
          correlationId,
        );
      }
    }

    if (input.loggingTier !== undefined) {
      yield* writeOrgSetting(
        input.orgId,
        LOGGING_TIER_KEY,
        input.loggingTier,
        input.actor,
        correlationId,
      );
    }

    if (input.retentionDefaultDays !== undefined) {
      yield* writeOrgSetting(
        input.orgId,
        RETENTION_DAYS_KEY,
        input.retentionDefaultDays,
        input.actor,
        correlationId,
      );
    }

    if (input.retentionLocation !== undefined) {
      yield* writeOrgSetting(
        input.orgId,
        RETENTION_LOCATION_KEY,
        input.retentionLocation,
        input.actor,
        correlationId,
      );
    }

    return yield* getOrgSettings(input.orgId);
  });
