import { Effect } from "effect";
import { ApprovalService } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import { ElevationRepoTag, type MachineRecord } from "./ElevationRepo";
import {
  type EventContext,
  buildElevationExpiredEvent,
  buildElevationGrantedEvent,
  buildElevationRequestedEvent,
} from "./events";
import { notifyOwnerOfElevation } from "./notify";
import {
  ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY,
  ADMIN_ACCESS_ELEVATION_TTL_MINUTES_SETTING_KEY,
  ADMIN_ACCESS_POLICY_SETTING_KEY,
  type SettingsChain,
  approvalModeSatisfiesFloor,
  requiredApprovalModeFloor,
  resolveAdminAccessApprovalMode,
  resolveAdminAccessPolicy,
  resolveElevationTtlMinutes,
} from "./policy";
import {
  ApprovalServiceCallError,
  type Elevation,
  ElevationInfraError,
  ElevationNotFoundError,
  ElevationPolicyDeniedError,
  ElevationStateError,
  type ElevationStatus,
  ElevationValidationError,
  MachineNotFoundError,
  PersonNotFoundError,
  type RequestElevationInput,
  SelfOwnedMachineError,
} from "./types";

type RequestElevationError =
  | ElevationValidationError
  | MachineNotFoundError
  | PersonNotFoundError
  | SelfOwnedMachineError
  | ElevationPolicyDeniedError
  | ApprovalServiceCallError
  | ElevationInfraError;

type SyncApprovalError =
  | ElevationNotFoundError
  | MachineNotFoundError
  | ApprovalServiceCallError
  | ElevationInfraError;

type ExpireError = ElevationNotFoundError | ElevationStateError | ElevationInfraError;

type GetError = ElevationNotFoundError | ElevationInfraError;

const SETTING_KEYS = [
  ADMIN_ACCESS_POLICY_SETTING_KEY,
  ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY,
  ADMIN_ACCESS_ELEVATION_TTL_MINUTES_SETTING_KEY,
] as const;

/**
 * Logs the real cause server-side (driver errors, connection failures, etc.
 * can contain internal detail — table/column names, connection strings)
 * but keeps the error returned to callers (and serialized straight into an
 * HTTP 500 body by `http/routes/elevations.ts`) to just the generic,
 * pre-known operation label.
 */
const toInfraError =
  (reasonPrefix: string) =>
  (cause: unknown): ElevationInfraError => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`[ElevationService] ${reasonPrefix}: ${detail}`);
    return new ElevationInfraError({ reason: reasonPrefix });
  };

/**
 * Wraps any `ApprovalService` call failure as `ApprovalServiceCallError` —
 * same posture as `toInfraError` above: log the real cause server-side,
 * return a safe reason to the caller.
 *
 * `ApprovalService`'s own failures are `ApprovalError` — an Effect
 * `Data.TaggedError`. That makes it `instanceof Error`, but Effect never
 * populates the native `Error.message` from a tagged error's fields, so
 * `.message` is always `""` — reading it (as a plain `Error` mapper would)
 * silently turns every `ApprovalServiceCallError` into an empty reason with
 * nothing logged either. The real, safe diagnostic is `ApprovalError`'s own
 * `.reason` (a small fixed enum — see `services/ApprovalService.ts`), so
 * read that first and fall back to `.message`/`String(cause)` only for a
 * genuinely different failure shape.
 */
const toApprovalServiceCallError = (cause: unknown): ApprovalServiceCallError => {
  const reason =
    cause && typeof cause === "object" && "reason" in cause && typeof cause.reason === "string"
      ? cause.reason
      : cause instanceof Error
        ? cause.message
        : String(cause);
  console.error(`[ElevationService] approval_service_call_failed: ${reason}`);
  return new ApprovalServiceCallError({ reason });
};

function scopeIdsFor(chain: SettingsChain): ReadonlyArray<string> {
  return chain.templateId
    ? [chain.orgId, chain.machineId, chain.templateId]
    : [chain.orgId, chain.machineId];
}

/**
 * The elevation / break-glass grant+policy layer (spec §15). Session
 * recording (what an elevated admin actually does once connected) is unit
 * 12/14's concern — this service only decides whether, and for how long, an
 * elevation exists. All persistence goes through `ElevationRepoTag` (see
 * `ElevationRepo.ts`) rather than `Db` directly, so this service's own unit
 * tests can mock the repo in-memory instead of needing a real database.
 */
export class ElevationService extends Effect.Service<ElevationService>()("ElevationService", {
  effect: Effect.gen(function* () {
    const repo = yield* ElevationRepoTag;
    const eventBus = yield* EventBus;
    const approvalService = yield* ApprovalService;

    const loadMachine = (machineId: string) =>
      repo.findMachine(machineId).pipe(
        Effect.mapError(toInfraError("machine_lookup_failed")),
        Effect.flatMap((row) =>
          row ? Effect.succeed(row) : Effect.fail(new MachineNotFoundError({ machineId })),
        ),
      );

    const loadPerson = (personId: string) =>
      repo.findPerson(personId).pipe(
        Effect.mapError(toInfraError("person_lookup_failed")),
        Effect.flatMap((row) =>
          // A deactivated person is treated the same as "not found" — same
          // rationale as the cross-org check below: never confirm-or-deny
          // more than the caller needs to know.
          row?.active ? Effect.succeed(row) : Effect.fail(new PersonNotFoundError({ personId })),
        ),
      );

    const loadElevation = (elevationId: string) =>
      repo.findElevation(elevationId).pipe(
        Effect.mapError(toInfraError("elevation_lookup_failed")),
        Effect.flatMap((row) =>
          row ? Effect.succeed(row) : Effect.fail(new ElevationNotFoundError({ elevationId })),
        ),
      );

    const loadSettingRows = (chain: SettingsChain) =>
      repo
        .findSettingRows(SETTING_KEYS, scopeIdsFor(chain))
        .pipe(Effect.mapError(toInfraError("settings_lookup_failed")));

    const publishEvents = (batch: Parameters<typeof eventBus.publish>[0]) =>
      eventBus.publish(batch).pipe(Effect.mapError(toInfraError("event_publish_failed")));

    const notifyIfOwned = (
      machine: Pick<MachineRecord, "id" | "ownerPersonId">,
      elevationRow: Elevation,
    ) =>
      machine.ownerPersonId
        ? notifyOwnerOfElevation(machine.ownerPersonId, machine.id, elevationRow)
        : Effect.void;

    /** Publishes the granted event (plus the requested event too, when this is the same call that created it) and notifies the owner. */
    const finalizeGrant = (
      elevationRow: Elevation,
      ctx: EventContext,
      machine: Pick<MachineRecord, "id" | "ownerPersonId">,
      includeRequestedEvent: boolean,
    ) =>
      Effect.gen(function* () {
        const batch = includeRequestedEvent
          ? [
              buildElevationRequestedEvent(elevationRow, ctx),
              buildElevationGrantedEvent(elevationRow, ctx),
            ]
          : [buildElevationGrantedEvent(elevationRow, ctx)];
        yield* publishEvents(batch);
        yield* notifyIfOwned(machine, elevationRow);
      });

    /**
     * `personId` actually owns `machineId` → no elevation needed at all. Not
     * an error path in the "denied" sense; this whole flow only exists for
     * admin access to a machine you *don't* own.
     */
    const request = (
      input: RequestElevationInput,
    ): Effect.Effect<Elevation, RequestElevationError> =>
      Effect.gen(function* () {
        const reason = input.reason.trim();
        if (!reason) {
          return yield* Effect.fail(new ElevationValidationError({ reason: "reason is required" }));
        }

        const [machine, person] = yield* Effect.all(
          [loadMachine(input.machineId), loadPerson(input.personId)],
          {
            concurrency: "unbounded",
          },
        );
        if (person.orgId !== machine.orgId) {
          // Deliberately reported as not-found, not cross-org — never leak that a
          // machine/person pair exists in another org.
          return yield* Effect.fail(new PersonNotFoundError({ personId: input.personId }));
        }

        if (machine.ownerPersonId === input.personId) {
          return yield* Effect.fail(
            new SelfOwnedMachineError({ machineId: machine.id, personId: input.personId }),
          );
        }

        const chain: SettingsChain = {
          orgId: machine.orgId,
          templateId: machine.templateId,
          machineId: machine.id,
        };
        const settingRows = yield* loadSettingRows(chain);
        const adminAccessPolicy = resolveAdminAccessPolicy(settingRows, chain);

        if (adminAccessPolicy === "never") {
          return yield* Effect.fail(
            new ElevationPolicyDeniedError({
              reason: `org "${ADMIN_ACCESS_POLICY_SETTING_KEY}" is "never" — admin access to a machine you don't own is not permitted`,
            }),
          );
        }

        const now = new Date();
        const ttlMinutes = resolveElevationTtlMinutes(settingRows, chain);

        if (adminAccessPolicy === "always") {
          // Still one generic approval object (spec §13) — mode "none" is an
          // auto-approved, fully logged, time-boxed grant, not a free-for-all.
          // (Note: "always" is the org's own explicit decision to skip
          // approval entirely for admin access to unowned machines — that
          // decision applies to both elevation levels. The dual-control
          // floor in `requiredApprovalModeFloor` below only governs the
          // `with_approval` branch, which is the only branch that has an
          // approval mode to escalate at all.)
          //
          // Goes through `ApprovalService.requestAutoApproved` — the exact
          // same insert+event path `ApprovalService.request()` itself uses
          // for a *resolved* mode "none" — rather than hand-rolling a
          // second, parallel raw insert with no approval-level events of
          // its own.
          const approvalResult = yield* approvalService
            .requestAutoApproved({
              orgId: machine.orgId,
              actionType: "admin_access",
              requestedByPersonId: input.personId,
              targetMachineId: machine.id,
              reason,
            })
            .pipe(Effect.mapError(toApprovalServiceCallError));

          const elevationRow = yield* repo
            .insertElevation({
              orgId: machine.orgId,
              personId: input.personId,
              machineId: machine.id,
              level: input.level,
              reason,
              approvalId: approvalResult.id,
              grantedAt: now,
              expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
              status: "granted",
            })
            .pipe(Effect.mapError(toInfraError("elevation_insert_failed")));

          const ctx: EventContext = {
            orgId: machine.orgId,
            actorType: "person",
            actorId: input.personId,
            machineId: machine.id,
            // The elevation's own id doubles as the correlation id, so every
            // event about this elevation — requested now, granted now or
            // later via `syncApproval`, eventually expired — shares one
            // correlationId an auditor can join on, with no extra column
            // needed on the (already-fixed) `elevations` table.
            correlationId: elevationRow.id,
            occurredAt: now,
          };
          yield* finalizeGrant(elevationRow, ctx, machine, true);
          return elevationRow;
        }

        // adminAccessPolicy === "with_approval"
        const requiredFloor = requiredApprovalModeFloor(input.level);
        const configuredMode = resolveAdminAccessApprovalMode(settingRows, chain);
        if (!approvalModeSatisfiesFloor(configuredMode, requiredFloor)) {
          return yield* Effect.fail(
            new ElevationPolicyDeniedError({
              reason:
                `level "${input.level}" requires the org's "${ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY}" setting ` +
                `to resolve to at least "${requiredFloor}", but it resolves to "${configuredMode}"`,
            }),
          );
        }

        const approvalResult = yield* approvalService
          .request({
            orgId: machine.orgId,
            actionType: "admin_access",
            requestedByPersonId: input.personId,
            targetMachineId: machine.id,
            reason,
          })
          .pipe(Effect.mapError(toApprovalServiceCallError));

        const initialStatus: ElevationStatus =
          approvalResult.status === "approved"
            ? "granted"
            : approvalResult.status === "pending"
              ? "requested"
              : "denied";

        const elevationRow = yield* repo
          .insertElevation({
            orgId: machine.orgId,
            personId: input.personId,
            machineId: machine.id,
            level: input.level,
            reason,
            approvalId: approvalResult.id,
            grantedAt: initialStatus === "granted" ? now : null,
            expiresAt:
              initialStatus === "granted" ? new Date(now.getTime() + ttlMinutes * 60_000) : null,
            status: initialStatus,
          })
          .pipe(Effect.mapError(toInfraError("elevation_insert_failed")));

        const ctx: EventContext = {
          orgId: machine.orgId,
          actorType: "person",
          actorId: input.personId,
          machineId: machine.id,
          correlationId: elevationRow.id,
          occurredAt: now,
        };

        if (initialStatus === "granted") {
          yield* finalizeGrant(elevationRow, ctx, machine, true);
        } else {
          yield* publishEvents([buildElevationRequestedEvent(elevationRow, ctx)]);
        }

        return elevationRow;
      });

    /**
     * Re-checks a `requested` elevation's approval and finalizes it: grants
     * on approval, denies on rejection/expiry, no-ops (returns as-is) while
     * still pending or already finalized. There is no webhook wiring this
     * up to `ApprovalService.decide` yet — call it after polling
     * `ApprovalService.status` or on whatever cadence unit 5's approvals UI
     * settles on.
     */
    const syncApproval = (elevationId: string): Effect.Effect<Elevation, SyncApprovalError> =>
      Effect.gen(function* () {
        const elevation = yield* loadElevation(elevationId);
        if (elevation.status !== "requested") return elevation;
        if (!elevation.approvalId) {
          return yield* Effect.fail(
            new ElevationInfraError({
              reason: `elevation ${elevationId} is "requested" but has no approvalId`,
            }),
          );
        }

        const approvalResult = yield* approvalService
          .status(elevation.approvalId)
          .pipe(Effect.mapError(toApprovalServiceCallError));

        if (approvalResult.status === "pending") return elevation;

        if (approvalResult.status === "approved") {
          const machine = yield* loadMachine(elevation.machineId);
          const chain: SettingsChain = {
            orgId: machine.orgId,
            templateId: machine.templateId,
            machineId: machine.id,
          };
          const settingRows = yield* loadSettingRows(chain);
          const ttlMinutes = resolveElevationTtlMinutes(settingRows, chain);
          const now = new Date();
          const updated = yield* repo
            .updateElevationGranted(elevationId, now, new Date(now.getTime() + ttlMinutes * 60_000))
            .pipe(Effect.mapError(toInfraError("elevation_grant_failed")));

          const ctx: EventContext = {
            orgId: elevation.orgId,
            actorType: "person",
            actorId: elevation.personId,
            machineId: elevation.machineId,
            // Same elevation id as the original `elevation_requested` event's
            // correlationId — see the comment in `request()`.
            correlationId: elevation.id,
            occurredAt: now,
          };
          yield* finalizeGrant(updated, ctx, machine, false);
          return updated;
        }

        // approvalResult.status is "rejected" or "expired": the approval
        // never came through. `ApprovalService` already emits
        // `approval.denied` / `approval.expired` for the audit trail (spec
        // §13: "Every decision writes an event, granted or denied") — we
        // just reflect the outcome on the elevation record itself.
        return yield* repo
          .updateElevationStatus(elevationId, "denied")
          .pipe(Effect.mapError(toInfraError("elevation_deny_failed")));
      });

    /**
     * Flips a `granted` elevation past its `expiresAt` to `expired` and
     * emits `access.elevation_expired`. Correct and safe to call blindly
     * from a future scheduled sweep (fails rather than acting on an
     * elevation that isn't granted, or hasn't actually expired yet) — no
     * sweep is scheduled by this unit.
     */
    const expire = (elevationId: string): Effect.Effect<void, ExpireError> =>
      Effect.gen(function* () {
        const elevation = yield* loadElevation(elevationId);
        if (elevation.status !== "granted") {
          return yield* Effect.fail(
            new ElevationStateError({
              elevationId,
              reason: `cannot expire an elevation in status "${elevation.status}" — only a "granted" elevation can expire`,
            }),
          );
        }
        if (!elevation.expiresAt) {
          return yield* Effect.fail(
            new ElevationStateError({
              elevationId,
              reason: "granted elevation is missing expiresAt",
            }),
          );
        }

        const now = new Date();
        if (now.getTime() < elevation.expiresAt.getTime()) {
          return yield* Effect.fail(
            new ElevationStateError({
              elevationId,
              reason: `not yet past expiresAt (${elevation.expiresAt.toISOString()})`,
            }),
          );
        }

        yield* repo
          .updateElevationStatus(elevationId, "expired")
          .pipe(Effect.mapError(toInfraError("elevation_expire_failed")));

        yield* publishEvents([
          buildElevationExpiredEvent(elevation, {
            orgId: elevation.orgId,
            actorType: "system",
            actorId: "elevation-expiry",
            machineId: elevation.machineId,
            correlationId: elevation.id,
            occurredAt: now,
          }),
        ]);
      });

    const get = (elevationId: string): Effect.Effect<Elevation, GetError> =>
      loadElevation(elevationId);

    return { request, syncApproval, expire, get } as const;
  }),
}) {}
