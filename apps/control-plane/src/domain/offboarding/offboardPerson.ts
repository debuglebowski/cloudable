import { Effect } from "effect";
import { type ApprovalResult, ApprovalService } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import { type ProvisioningError, ProvisioningServiceTag } from "../../services/ProvisioningService";
import { buildEvent } from "../build-event";
import { CertificateRevokerTag } from "./CertificateRevoker";
import { MachineArchiverTag } from "./MachineArchiver";
import { type OffboardingPerson, OffboardingRepoTag } from "./OffboardingRepo";
import { SessionTerminatorTag } from "./SessionTerminator";
import { OffboardingError } from "./errors";

export interface MachineOffboardFailure {
  machineId: string;
  cause: unknown;
}

export interface OffboardPersonOutcome {
  approvalId: string;
  /** `"approved"` means the sequence below ran for at least an attempt at every owned machine; any other status means it never started. */
  status: ApprovalResult["status"];
  /** Machines that completed the full stop -> clear owner -> archive -> `machine.offboarded` sequence. */
  machinesOffboarded: string[];
  /**
   * Machines whose sequence failed partway through. Each one is isolated —
   * one machine failing does not stop the others from being attempted (see
   * the per-machine loop below) — but see this unit's PR notes on the
   * residual risk of a machine left mid-sequence (e.g. owner cleared but
   * not yet archived) when it fails between two of its own steps.
   */
  machineFailures: MachineOffboardFailure[];
}

/** Wraps any sub-service error into the orchestration's single error type, preserving the cause. */
const wrap = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, OffboardingError> =>
  effect.pipe(
    Effect.mapError((cause) => new OffboardingError({ reason: "sub_operation_failed", cause })),
  );

type SequenceServices =
  | OffboardingRepoTag
  | CertificateRevokerTag
  | MachineArchiverTag
  | SessionTerminatorTag
  | ProvisioningServiceTag
  | EventBus;

/**
 * The actual work an APPROVED offboarding does: revoke live certificates,
 * then per owned machine, stop -> clear owner -> archive -> `machine.offboarded`.
 * Shared by both entry points below (`offboardPersonDetailed`'s immediate path
 * and `resumeOffboarding`'s deferred path) so there is exactly one place this
 * sequence — and its ordering guarantee — is implemented.
 *
 * ORDER (per machine, and asserted by this file's tests):
 *   certificates revoked -> machine stopped -> owner cleared -> archived -> `machine.offboarded`
 *
 * Certificates are revoked ONCE for the whole person, up front, rather than
 * re-queried inside the per-machine loop: a certificate's `machineScope` can
 * cover multiple machines (or the literal "all"), so revoking per-machine
 * iteration would either double-revoke a cert or need its own dedup
 * bookkeeping for no benefit. A cert-revocation failure IS fatal to the whole
 * call (no machine is touched) — unlike a single machine's own failure below,
 * this step is compliance-critical and person-wide, so failing fast here is
 * deliberate.
 *
 * Each owned machine's sequence is isolated with `Effect.either`: one machine
 * failing (e.g. a transient DB error during its own archive step) does not
 * stop the remaining machines from being attempted. This does NOT make an
 * individual machine's own 3-step sequence transactional — a failure between
 * two of ITS OWN steps can still leave that one machine in an intermediate
 * state (see this unit's PR notes).
 *
 * Safe to call twice for the same person (which `resumeOffboarding` relies
 * on): `OffboardingRepo.findLiveCertificateIds`/`findOwnedMachines` only ever
 * return certificates not yet revoked and machines not yet archived, so a
 * repeat call naturally finds nothing left to do rather than double-acting.
 */
const runOffboardingSequence = (
  person: OffboardingPerson,
  approvalId: string,
  requestedByPersonId: string,
  reason: string,
): Effect.Effect<
  { machinesOffboarded: string[]; machineFailures: MachineOffboardFailure[] },
  OffboardingError,
  SequenceServices
> =>
  Effect.gen(function* () {
    const repo = yield* OffboardingRepoTag;
    const certificateRevoker = yield* CertificateRevokerTag;
    const machineArchiver = yield* MachineArchiverTag;
    const sessionTerminator = yield* SessionTerminatorTag;
    const provisioning = yield* ProvisioningServiceTag;
    const eventBus = yield* EventBus;

    const liveCertificateIds = yield* wrap(repo.findLiveCertificateIds(person.id));
    // Carry the caller's actual free-text reason through to every revoked
    // certificate's record and event, not a generic "offboarding" literal —
    // an auditor reading the certificate/event trail should be able to
    // recover WHY access was revoked (e.g. "Terminated for cause, HR ticket
    // #4521"), not just that it happened during an offboarding flow.
    const revokeReason = `offboarding: ${reason}`;
    for (const certificateId of liveCertificateIds) {
      yield* wrap(certificateRevoker.revoke(certificateId, revokeReason));
      yield* wrap(
        eventBus.publish([
          buildEvent("access.certificate_revoked", {
            orgId: person.orgId,
            actorType: "person",
            actorId: requestedByPersonId,
            machineId: null,
            correlationId: approvalId,
            payload: { certificateId, reason: revokeReason },
          }),
        ]),
      );
    }

    const ownedMachines = yield* wrap(repo.findOwnedMachines(person.id));
    const machinesOffboarded: string[] = [];
    const machineFailures: MachineOffboardFailure[] = [];

    const offboardOneMachine = (machineId: string): Effect.Effect<void, OffboardingError> =>
      Effect.gen(function* () {
        // "Stop" the machine. `ProvisioningService` has no bare `stop()` —
        // its `archive()` is the closest cloud-level equivalent (see this
        // unit's PR notes). A `not_found` here means the cloud resource is
        // already gone (or, in this build, was never created via
        // `provisioning.create` — no machine-creation flow exists yet);
        // that is treated as already-stopped rather than a hard failure, so
        // offboarding a machine seeded directly in Postgres still completes.
        yield* provisioning.archive(machineId).pipe(
          Effect.catchTag("ProvisioningError", (error: ProvisioningError) =>
            error.reason === "not_found" ? Effect.void : Effect.fail(error),
          ),
          wrap,
        );

        yield* wrap(repo.markMachineStopped(machineId));
        yield* wrap(
          eventBus.publish([
            buildEvent("machine.stopped", {
              orgId: person.orgId,
              actorType: "person",
              actorId: requestedByPersonId,
              machineId,
              correlationId: approvalId,
              payload: { initiator: "offboarding" },
            }),
          ]),
        );

        yield* wrap(repo.clearMachineOwner(machineId));
        yield* wrap(
          eventBus.publish([
            buildEvent("machine.owner_cleared", {
              orgId: person.orgId,
              actorType: "person",
              actorId: requestedByPersonId,
              machineId,
              correlationId: approvalId,
              payload: { previousPersonId: person.id },
            }),
          ]),
        );

        // Emits `machine.archived` and starts the retention clock itself.
        yield* wrap(machineArchiver.archive(machineId, approvalId));

        // Archiving must actually kill any live terminal/SSH session on the
        // machine, not just leave the DB saying it was terminated while a real connection
        // stays open. A no-op if the machine had none.
        yield* wrap(
          sessionTerminator.terminateForMachine(person.orgId, machineId, "policy_terminated"),
        );

        yield* wrap(
          eventBus.publish([
            buildEvent("machine.offboarded", {
              orgId: person.orgId,
              actorType: "person",
              actorId: requestedByPersonId,
              machineId,
              correlationId: approvalId,
              payload: { previousOwnerId: person.id, approvalId },
            }),
          ]),
        );
      });

    for (const machine of ownedMachines) {
      const result = yield* Effect.either(offboardOneMachine(machine.id));
      if (result._tag === "Right") {
        machinesOffboarded.push(machine.id);
      } else {
        machineFailures.push({ machineId: machine.id, cause: result.left });
      }
    }

    return { machinesOffboarded, machineFailures };
  });

/**
 * Approval-gated offboarding: requests approval, and — only
 * once it resolves to `"approved"` in the SAME call (mode `"none"`, or an
 * org policy that auto-grants) — runs `runOffboardingSequence` immediately.
 *
 * This is the richer variant — it reports what actually happened, which the
 * HTTP handler needs to build a meaningful response. `offboardPerson` below
 * is the exact `Effect<void, ...>` signature described in the spec and
 * delegates to this.
 *
 * A DENIED (or pending/expired) approval is a true no-op beyond the approval
 * record itself: no certs are queried or revoked, no machine is touched.
 * This function returns `approval.status` unchanged, straight from
 * `ApprovalService.request`, without querying anything else. `"pending"`
 * (single/dual approval mode) is NOT abandoned, though — once that approval
 * is later decided, `resumeOffboarding` (below) picks up exactly where this
 * left off, keyed by the approval's own `targetPersonId`.
 */
export const offboardPersonDetailed = (
  personId: string,
  requestedByPersonId: string,
  reason: string,
): Effect.Effect<OffboardPersonOutcome, OffboardingError, SequenceServices | ApprovalService> =>
  Effect.gen(function* () {
    const repo = yield* OffboardingRepoTag;
    const approvals = yield* ApprovalService;

    const person = yield* wrap(repo.findPerson(personId));
    if (!person) {
      return yield* Effect.fail(
        new OffboardingError({ reason: "person_not_found", cause: personId }),
      );
    }

    // Person-level action: it may affect several machines, so
    // `targetMachineId` is legitimately null here (see this unit's PR notes).
    // `targetPersonId` is what `resumeOffboarding` later looks this approval
    // back up by — without it, a pending offboarding approval would carry no
    // record of WHO it's for once this call returns.
    const approval = yield* wrap(
      approvals.request({
        orgId: person.orgId,
        actionType: "offboarding",
        requestedByPersonId,
        targetMachineId: null,
        targetPersonId: personId,
        reason,
      }),
    );

    // Only an already-granted approval proceeds. Denied/pending/expired halt
    // right here — no certs queried, no machine touched: a confirmation
    // dialog is self-approval and is not an approval.
    if (approval.status !== "approved") {
      return {
        approvalId: approval.id,
        status: approval.status,
        machinesOffboarded: [],
        machineFailures: [],
      };
    }

    const { machinesOffboarded, machineFailures } = yield* runOffboardingSequence(
      person,
      approval.id,
      requestedByPersonId,
      reason,
    );

    return {
      approvalId: approval.id,
      status: approval.status,
      machinesOffboarded,
      machineFailures,
    };
  });

/**
 * `offboardPerson(personId, requestedByPersonId, reason): Effect<void, ...>`
 * — the exact signature this unit's spec describes. See
 * `offboardPersonDetailed` above for the full behavior; this is a thin
 * `Effect.asVoid` wrapper for callers (and tests) that only care about
 * success/failure, not the outcome detail.
 */
export const offboardPerson = (
  personId: string,
  requestedByPersonId: string,
  reason: string,
): Effect.Effect<void, OffboardingError, SequenceServices | ApprovalService> =>
  offboardPersonDetailed(personId, requestedByPersonId, reason).pipe(Effect.asVoid);

/**
 * Resumes offboarding once a PENDING approval (single/dual approval mode —
 * `offboardPersonDetailed` returned `status: "pending"` and touched nothing
 * beyond the approval record itself) has since been decided by
 * `ApprovalService.decide()`. There is no webhook wiring `decide()` straight
 * into this — same "sync" shape `ElevationService.syncApproval` already uses
 * for admin-access elevations (see that file's doc comment) rather than a
 * push callback: the caller (console button, or a future poll) re-checks and
 * this resumes if there's anything to resume.
 *
 * Looked up by `approvalId` alone — `targetPersonId` (this iteration's new
 * column on `approvals`, see `services/ApprovalService.ts`) is what makes
 * that possible; before it existed there was no way to recover WHICH person
 * a pending offboarding approval was even for once the original HTTP
 * response was gone.
 *
 * A safe no-op, callable repeatedly: still pending returns unchanged;
 * already resumed once finds no live certificates or owned (non-archived)
 * machines left and simply returns empty results, per
 * `runOffboardingSequence`'s own idempotency note.
 */
export const resumeOffboarding = (
  approvalId: string,
  orgId: string,
): Effect.Effect<OffboardPersonOutcome, OffboardingError, SequenceServices | ApprovalService> =>
  Effect.gen(function* () {
    const repo = yield* OffboardingRepoTag;
    const approvals = yield* ApprovalService;

    const approval = yield* wrap(approvals.status(approvalId, orgId));
    if (approval.actionType !== "offboarding" || !approval.targetPersonId) {
      return yield* Effect.fail(
        new OffboardingError({ reason: "invalid_approval", cause: approvalId }),
      );
    }

    if (approval.status !== "approved") {
      return {
        approvalId: approval.id,
        status: approval.status,
        machinesOffboarded: [],
        machineFailures: [],
      };
    }

    const person = yield* wrap(repo.findPerson(approval.targetPersonId));
    if (!person) {
      return yield* Effect.fail(
        new OffboardingError({ reason: "person_not_found", cause: approval.targetPersonId }),
      );
    }

    const { machinesOffboarded, machineFailures } = yield* runOffboardingSequence(
      person,
      approval.id,
      approval.requestedByPersonId,
      approval.reason,
    );

    return {
      approvalId: approval.id,
      status: approval.status,
      machinesOffboarded,
      machineFailures,
    };
  });
