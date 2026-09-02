import { approvals, machines } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { EventBus, type EventBusError } from "../../services/EventBus";
import { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { ArchiveDbError, MachineAlreadyArchivedError } from "./errors";
import { SYSTEM_ACTOR, makeEnvelope } from "./events";
import { type MachineRow, dbTry, fetchMachine } from "./queries";
import { createSnapshot } from "./snapshot";

const publishOrDie = <A>(
  effect: Effect.Effect<A, EventBusError>,
): Effect.Effect<A, ArchiveDbError> =>
  effect.pipe(
    Effect.mapError(
      (cause) => new ArchiveDbError({ reason: `event_publish_failed: ${cause.reason}` }),
    ),
  );

/** Best-effort actor attribution: if the caller already has an `approvalId` (e.g. an
 * offboarding flow that obtained approval before calling archive), attribute the
 * `machine.archived` event to whoever requested that approval — but only when that
 * approval genuinely belongs to this machine's org and was actually approved. Anything
 * else (a lookup failure, an unknown id, a pending/rejected/cross-org approval) falls
 * back to the `"system"` actor rather than either failing the archive or misattributing
 * it to someone who never approved this specific action. */
const resolveArchiveActor = (approvalId: string | undefined, machine: MachineRow) =>
  Effect.gen(function* () {
    if (!approvalId) return SYSTEM_ACTOR;
    const db = yield* Db;
    const rows = yield* dbTry(
      () => db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1),
      "fetch_approval_for_archive_actor",
    ).pipe(Effect.orElseSucceed(() => [] as (typeof approvals.$inferSelect)[]));
    const approval = rows[0];
    const isUsable = approval && approval.orgId === machine.orgId && approval.status === "approved";
    return isUsable
      ? { actorType: "person" as const, actorId: approval.requestedByPersonId }
      : SYSTEM_ACTOR;
  });

/**
 * Archives a machine: calls `ProvisioningService.archive()` for the actual
 * machine-side archive action, moves `machines.state` to `"archived_restorable"` with
 * `archivedAt` set, takes a final snapshot (`createSnapshot(machineId, "archive")`),
 * and emits `machine.archived` with `{snapshotId, retentionExpiresAt}`.
 *
 * `approvalId` is optional and passed through, not requested here — archiving a machine
 * directly is not itself on the approval-consumer list (offboarding is; the approval-gated
 * offboarding flow builds on top of this primitive and passes the approval id it already
 * obtained).
 *
 * Signature is exact and load-bearing — callers depend on it directly. Do not add
 * required parameters.
 *
 * Archiving is a one-way transition (live -> archived): a machine already in
 * `"archived_restorable"` or `"archived_expired"` fails with `MachineAlreadyArchivedError`
 * rather than being archived a second time (which would duplicate the snapshot and the
 * `machine.archived` event for one logical action).
 */
export const archiveMachine = (machineId: string, approvalId?: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const provisioning = yield* ProvisioningServiceTag;
    const eventBus = yield* EventBus;

    const machine = yield* fetchMachine(machineId);
    if (machine.state === "archived_restorable" || machine.state === "archived_expired") {
      return yield* Effect.fail(
        new MachineAlreadyArchivedError({ machineId, state: machine.state }),
      );
    }

    yield* provisioning.archive(machineId);

    const now = new Date();
    yield* dbTry(
      () =>
        db
          .update(machines)
          .set({ state: "archived_restorable", archivedAt: now })
          .where(eq(machines.id, machineId)),
      "update_machine_archived",
    );

    const correlationId = ulid();
    const snapshot = yield* createSnapshot(machineId, "archive", correlationId, machine);
    const actor = yield* resolveArchiveActor(approvalId, machine);

    yield* publishOrDie(
      eventBus.publish([
        {
          ...makeEnvelope({ orgId: machine.orgId, machineId, correlationId, ...actor }),
          type: "machine.archived",
          payload: {
            snapshotId: snapshot.id,
            retentionExpiresAt: snapshot.expiresAt.toISOString(),
          },
        },
      ]),
    );
  });
