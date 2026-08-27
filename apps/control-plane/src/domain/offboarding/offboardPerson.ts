import { Effect } from "effect";
import { type ApprovalResult, ApprovalService } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import { type ProvisioningError, ProvisioningServiceTag } from "../../services/ProvisioningService";
import { buildEvent } from "../build-event";
import { CertificateRevokerTag } from "./CertificateRevoker";
import { MachineArchiverTag } from "./MachineArchiver";
import { OffboardingRepoTag } from "./OffboardingRepo";
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

/**
 * Approval-gated offboarding, per spec §14: revoke live certificates, stop
 * every machine the person owns, clear ownership, archive each machine
 * (starting its retention clock), and emit the umbrella `machine.offboarded`
 * event per machine.
 *
 * This is the richer variant — it reports what actually happened, which the
 * HTTP handler needs to build a meaningful response. `offboardPerson` below
 * is the exact `Effect<void, ...>` signature described in the spec and
 * delegates to this.
 *
 * ORDER (per machine, and asserted by this file's tests):
 *   certificates revoked -> machine stopped -> owner cleared -> archived -> `machine.offboarded`
 *
 * Certificates are revoked ONCE for the whole person, up front, rather than
 * re-queried inside the per-machine loop: a certificate's `machineScope` can
 * cover multiple machines (or the literal "all"), so revoking per-machine
 * iteration would either double-revoke a cert or need its own dedup
 * bookkeeping for no benefit. This still produces the required global
 * ordering (certs, then per-machine stop -> clear -> archive) without
 * redundant revoke calls. A cert-revocation failure IS fatal to the whole
 * request (no machine is touched) — unlike a single machine's own failure
 * below, this step is compliance-critical and person-wide, so failing
 * fast here is deliberate.
 *
 * Each owned machine's sequence is isolated with `Effect.either`: one
 * machine failing (e.g. a transient DB error during its own archive step)
 * does not stop the remaining machines from being attempted. Failures are
 * collected into `machineFailures` rather than aborting the whole request,
 * so offboarding a person with N machines makes a best effort across all N
 * instead of stopping at the first failure. This does NOT make an
 * individual machine's own 3-step sequence (stop -> clear -> archive)
 * transactional — a failure between two of ITS OWN steps can still leave
 * that one machine in an intermediate state (see this unit's PR notes).
 *
 * A DENIED (or pending/expired) approval is a true no-op beyond the
 * approval record itself: no certs are queried or revoked, no machine is
 * touched. This function returns `approval.status` unchanged, straight from
 * `ApprovalService.request`, without querying anything else.
 */
export const offboardPersonDetailed = (
  personId: string,
  requestedByPersonId: string,
  reason: string,
): Effect.Effect<
  OffboardPersonOutcome,
  OffboardingError,
  | OffboardingRepoTag
  | CertificateRevokerTag
  | MachineArchiverTag
  | ApprovalService
  | ProvisioningServiceTag
  | EventBus
> =>
  Effect.gen(function* () {
    const repo = yield* OffboardingRepoTag;
    const certificateRevoker = yield* CertificateRevokerTag;
    const machineArchiver = yield* MachineArchiverTag;
    const approvals = yield* ApprovalService;
    const provisioning = yield* ProvisioningServiceTag;
    const eventBus = yield* EventBus;

    const person = yield* wrap(repo.findPerson(personId));
    if (!person) {
      return yield* Effect.fail(
        new OffboardingError({ reason: "person_not_found", cause: personId }),
      );
    }

    // Person-level action: it may affect several machines, so
    // `targetMachineId` is legitimately null here (see this unit's PR notes).
    const approval = yield* wrap(
      approvals.request({
        orgId: person.orgId,
        actionType: "offboarding",
        requestedByPersonId,
        targetMachineId: null,
        reason,
      }),
    );

    // Only an already-granted approval proceeds. Denied/pending/expired halt
    // right here — no certs queried, no machine touched — per spec §14
    // ("a confirmation dialog is self-approval and is not an approval").
    if (approval.status !== "approved") {
      return {
        approvalId: approval.id,
        status: approval.status,
        machinesOffboarded: [],
        machineFailures: [],
      };
    }

    const liveCertificateIds = yield* wrap(repo.findLiveCertificateIds(personId));
    for (const certificateId of liveCertificateIds) {
      yield* wrap(certificateRevoker.revoke(certificateId, "offboarding"));
      yield* wrap(
        eventBus.publish([
          buildEvent("access.certificate_revoked", {
            orgId: person.orgId,
            actorType: "person",
            actorId: requestedByPersonId,
            machineId: null,
            correlationId: approval.id,
            payload: { certificateId, reason: "offboarding" },
          }),
        ]),
      );
    }

    const ownedMachines = yield* wrap(repo.findOwnedMachines(personId));
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
              correlationId: approval.id,
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
              correlationId: approval.id,
              payload: { previousPersonId: personId },
            }),
          ]),
        );

        // Emits `machine.archived` and starts the retention clock itself.
        yield* wrap(machineArchiver.archive(machineId, approval.id));

        yield* wrap(
          eventBus.publish([
            buildEvent("machine.offboarded", {
              orgId: person.orgId,
              actorType: "person",
              actorId: requestedByPersonId,
              machineId,
              correlationId: approval.id,
              payload: { previousOwnerId: personId, approvalId: approval.id },
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
): Effect.Effect<
  void,
  OffboardingError,
  | OffboardingRepoTag
  | CertificateRevokerTag
  | MachineArchiverTag
  | ApprovalService
  | ProvisioningServiceTag
  | EventBus
> => offboardPersonDetailed(personId, requestedByPersonId, reason).pipe(Effect.asVoid);
