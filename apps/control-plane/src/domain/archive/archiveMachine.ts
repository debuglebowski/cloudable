import {
  type SettingRow,
  machines,
  resolveSetting,
  settingValues,
  snapshots,
} from "@cloudable/schema";
import { and, eq, or } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { buildEvent } from "../build-event";

export class ArchiveError extends Data.TaggedError("ArchiveError")<{
  reason: "not_found" | "db_error";
  cause?: unknown;
}> {}

export interface MachineArchiveResult {
  snapshotId: string;
  retentionExpiresAt: Date;
}

const DEFAULT_RETENTION_DAYS = 30;

/**
 * STUB for unit 15's `apps/control-plane/src/domain/archive/*`
 * (`archiveMachine(machineId, approvalId?)` — see the PR that adds this
 * unit for the full cross-unit note). This file exists so unit 16
 * (offboarding) has a real, working implementation to call end-to-end
 * without waiting for unit 15's real archive/snapshot/restore logic to
 * merge.
 *
 * CONSOLIDATION: when unit 15 merges its real implementation at this same
 * path, delete this file's body and re-export theirs. Callers only depend
 * on the exported function's name and signature (`archiveMachine(machineId,
 * approvalId?): Effect<MachineArchiveResult, ArchiveError, Db | EventBus>`),
 * so nothing downstream (`domain/offboarding/MachineArchiver.default.ts`)
 * needs to change.
 *
 * Minimal working behavior:
 *  - final snapshot row (trigger: "archive")
 *  - machine -> `archived_restorable`, `archivedAt` set
 *  - retention window from the `retention.days` setting, resolved through
 *    the org -> machine chain via `resolveSetting` (default 30 days per
 *    spec §14 when nothing is declared at either scope; no template layer
 *    exists in v1 — see CLAUDE.md)
 *  - emits `machine.archived` itself, starting the retention clock — the
 *    caller (offboarding) does not emit this event.
 */
export const archiveMachine = (
  machineId: string,
  approvalId?: string,
): Effect.Effect<MachineArchiveResult, ArchiveError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;

    const [machine] = yield* Effect.tryPromise({
      try: () => db.select().from(machines).where(eq(machines.id, machineId)).limit(1),
      catch: (cause) => new ArchiveError({ reason: "db_error", cause }),
    });
    if (!machine) {
      return yield* Effect.fail(new ArchiveError({ reason: "not_found", cause: machineId }));
    }

    // Org- and machine-scoped `retention.days` rows (no template layer in
    // v1 — see CLAUDE.md "Not in v1"), resolved via the shared
    // `resolveSetting` so a machine-level override actually wins per the
    // org -> template -> machine inheritance model (spec §5).
    const retentionRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(settingValues)
          .where(
            and(
              eq(settingValues.key, "retention.days"),
              or(
                and(eq(settingValues.scopeType, "org"), eq(settingValues.scopeId, machine.orgId)),
                and(eq(settingValues.scopeType, "machine"), eq(settingValues.scopeId, machineId)),
              ),
            ),
          ),
      catch: (cause) => new ArchiveError({ reason: "db_error", cause }),
    });
    const resolvedRetention = resolveSetting<number>(
      "retention.days",
      retentionRows as unknown as SettingRow<number>[],
      { orgId: machine.orgId, templateId: machine.templateId ?? null, machineId },
    );
    const retentionDays =
      typeof resolvedRetention?.value === "number"
        ? resolvedRetention.value
        : DEFAULT_RETENTION_DAYS;

    const now = new Date();
    const retentionExpiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

    const [snapshot] = yield* Effect.tryPromise({
      try: () =>
        db
          .insert(snapshots)
          .values({
            orgId: machine.orgId,
            machineId,
            trigger: "archive",
            region: machine.region,
            containsData: true,
            containsConfig: true,
            retentionDays,
            expiresAt: retentionExpiresAt,
          })
          .returning(),
      catch: (cause) => new ArchiveError({ reason: "db_error", cause }),
    });

    if (!snapshot) {
      return yield* Effect.fail(
        new ArchiveError({ reason: "db_error", cause: "snapshot insert returned no row" }),
      );
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .update(machines)
          .set({ state: "archived_restorable", archivedAt: now })
          .where(eq(machines.id, machineId)),
      catch: (cause) => new ArchiveError({ reason: "db_error", cause }),
    });

    yield* eventBus
      .publish([
        buildEvent("machine.archived", {
          orgId: machine.orgId,
          // The archive step itself is a system consequence of an approved
          // workflow (offboarding, or a future manual archive action) —
          // `correlationId` links back to the approval for evidence.
          actorType: "system",
          actorId: "system",
          machineId,
          correlationId: approvalId ?? machineId,
          payload: {
            snapshotId: snapshot.id,
            retentionExpiresAt: retentionExpiresAt.toISOString(),
          },
        }),
      ])
      .pipe(Effect.mapError((cause) => new ArchiveError({ reason: "db_error", cause })));

    return { snapshotId: snapshot.id, retentionExpiresAt };
  });
