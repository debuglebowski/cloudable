import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "@cloudable/events";
import { Effect, Layer } from "effect";
import {
  type ApprovalRequest,
  type ApprovalResult,
  ApprovalService,
} from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import {
  type ProvisioningService,
  ProvisioningServiceTag,
} from "../../services/ProvisioningService";
import { ArchiveDbError } from "../archive/errors";
import { type CertificateRevoker, CertificateRevokerTag } from "./CertificateRevoker";
import { type MachineArchiver, MachineArchiverTag } from "./MachineArchiver";
import { type OffboardingRepo, OffboardingRepoTag } from "./OffboardingRepo";
import { type SessionTerminator, SessionTerminatorTag } from "./SessionTerminator";
import { OffboardingError } from "./errors";
import { offboardPerson, offboardPersonDetailed, resumeOffboarding } from "./offboardPerson";

const PERSON_ID = "person-1";
const ORG_ID = "org-1";
const REQUESTED_BY = "admin-1";
const MACHINE_A = "machine-a";
const MACHINE_B = "machine-b";
const CERT_1 = "cert-1";
const CERT_2 = "cert-2";

/**
 * Builds a full layer stack for `offboardPersonDetailed`/`offboardPerson`
 * out of hand-rolled fakes for every sub-service — no real Postgres, no
 * real ApprovalService/ProvisioningService — that append a label to a
 * shared `calls` array on every invocation, so tests can assert both
 * *that* a step ran and the *order* it ran in.
 */
function buildTestLayers(opts: {
  approvalStatus: ApprovalResult["status"];
  calls: string[];
  ownedMachines?: string[];
  liveCertificateIds?: string[];
  /** Machine id whose `machineArchiver.archive` call should fail, to test per-machine isolation. */
  failArchiveForMachine?: string;
  /** What `ApprovalService.status(...)` reports — `resumeOffboarding` reads this, not
   * `.request()`'s return value. Defaults to mirroring `approvalStatus`/a real
   * `targetPersonId`, since that's what a genuine offboarding approval always carries
   * (this iteration's fix — see `services/ApprovalService.ts`). Override to test
   * `resumeOffboarding` against a malformed/foreign approval. */
  statusResult?: Partial<ApprovalResult>;
}) {
  const { approvalStatus, calls } = opts;
  const ownedMachines = opts.ownedMachines ?? [MACHINE_A, MACHINE_B];
  const liveCertificateIds = opts.liveCertificateIds ?? [CERT_1, CERT_2];

  const repo: OffboardingRepo = {
    findPerson: (personId) =>
      Effect.sync(() => {
        calls.push("repo.findPerson");
        return personId === PERSON_ID ? { id: PERSON_ID, orgId: ORG_ID } : null;
      }),
    findOwnedMachines: () =>
      Effect.sync(() => {
        calls.push("repo.findOwnedMachines");
        return ownedMachines.map((id) => ({ id }));
      }),
    findLiveCertificateIds: () =>
      Effect.sync(() => {
        calls.push("repo.findLiveCertificateIds");
        return liveCertificateIds;
      }),
    markMachineStopped: (machineId) =>
      Effect.sync(() => void calls.push(`repo.markMachineStopped:${machineId}`)),
    clearMachineOwner: (machineId) =>
      Effect.sync(() => void calls.push(`repo.clearMachineOwner:${machineId}`)),
  };

  const certificateRevoker: CertificateRevoker = {
    revoke: (certificateId) =>
      Effect.sync(() => {
        calls.push(`cert.revoke:${certificateId}`);
        return { certificateId, revokedAt: new Date() };
      }),
  };

  const machineArchiver: MachineArchiver = {
    archive: (machineId) =>
      Effect.sync(() => calls.push(`archiver.archive:${machineId}`)).pipe(
        Effect.flatMap(() =>
          machineId === opts.failArchiveForMachine
            ? Effect.fail(
                new ArchiveDbError({
                  reason: `simulated failure for ${machineId}`,
                }),
              )
            : Effect.void,
        ),
      ),
  };

  const sessionTerminator: SessionTerminator = {
    terminateForMachine: (_orgId, machineId) =>
      Effect.sync(() => void calls.push(`sessionTerminator.terminateForMachine:${machineId}`)),
  };

  const provisioning: ProvisioningService = {
    create: () => Effect.die("not used in this test"),
    archive: (machineId) =>
      Effect.sync(() => {
        calls.push(`provisioning.archive:${machineId}`);
        return { machineId, state: "archived" as const, externalId: `fake-${machineId}` };
      }),
    reconcile: () => Effect.die("not used in this test"),
    reimage: () => Effect.die("not used in this test"),
    restart: () => Effect.die("not used in this test"),
  };

  const approvalResult: ApprovalResult = {
    id: "approval-1",
    orgId: "org-1",
    actionType: "offboarding",
    mode: "none",
    status: approvalStatus,
    requestedByPersonId: "requester-1",
    targetMachineId: null,
    targetPersonId: PERSON_ID,
    reason: "test",
    requiredApprovals: 0,
    approvedCount: 0,
    createdAt: new Date(),
    expiresAt: new Date(),
    decidedAt: null,
  };
  const statusResult: ApprovalResult = { ...approvalResult, ...opts.statusResult };
  const approvalServiceImpl = {
    request: (_req: ApprovalRequest) =>
      Effect.sync(() => {
        calls.push("approval.request");
        return approvalResult;
      }),
    decide: () => Effect.die("not used in this test"),
    status: () =>
      Effect.sync(() => {
        calls.push("approval.status");
        return statusResult;
      }),
    list: () => Effect.die("not used in this test"),
    requestAutoApproved: () => Effect.die("not used in this test"),
  };

  const eventBusImpl = {
    publish: (batch: ReadonlyArray<DomainEvent>) =>
      Effect.sync(() => void calls.push(`event:${batch.map((e) => e.type).join(",")}`)),
  };

  return Layer.mergeAll(
    Layer.succeed(OffboardingRepoTag, repo),
    Layer.succeed(CertificateRevokerTag, certificateRevoker),
    Layer.succeed(MachineArchiverTag, machineArchiver),
    Layer.succeed(SessionTerminatorTag, sessionTerminator),
    Layer.succeed(ProvisioningServiceTag, provisioning),
    Layer.succeed(ApprovalService, ApprovalService.make(approvalServiceImpl)),
    Layer.succeed(EventBus, EventBus.make(eventBusImpl)),
  );
}

describe("offboardPerson", () => {
  test("approved: revokes every live cert, then per machine stops -> clears owner -> archives, in order", async () => {
    const calls: string[] = [];
    const layers = buildTestLayers({ approvalStatus: "approved", calls });

    const outcome = await Effect.runPromise(
      Effect.provide(
        offboardPersonDetailed(PERSON_ID, REQUESTED_BY, "leaving the company"),
        layers,
      ),
    );

    expect(outcome.status).toBe("approved");
    expect(outcome.approvalId).toBe("approval-1");
    expect(outcome.machinesOffboarded).toEqual([MACHINE_A, MACHINE_B]);
    expect(outcome.machineFailures).toEqual([]);

    // Certs are revoked once, up front — before any machine is touched.
    const certRevokeIdx = [
      calls.indexOf("cert.revoke:cert-1"),
      calls.indexOf("cert.revoke:cert-2"),
    ];
    const firstMachineStepIdx = calls.indexOf(`provisioning.archive:${MACHINE_A}`);
    expect(certRevokeIdx.every((i) => i >= 0 && i < firstMachineStepIdx)).toBe(true);

    // Per machine A: stop -> clear owner -> archive -> terminate live sessions, in that order.
    const stopIdx = calls.indexOf(`provisioning.archive:${MACHINE_A}`);
    const clearIdx = calls.indexOf(`repo.clearMachineOwner:${MACHINE_A}`);
    const archiveIdx = calls.indexOf(`archiver.archive:${MACHINE_A}`);
    const terminateIdx = calls.indexOf(`sessionTerminator.terminateForMachine:${MACHINE_A}`);
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThan(stopIdx);
    expect(archiveIdx).toBeGreaterThan(clearIdx);
    expect(terminateIdx).toBeGreaterThan(archiveIdx);

    // Same for machine B, and machine B's sequence starts after machine A's finishes.
    const stopIdxB = calls.indexOf(`provisioning.archive:${MACHINE_B}`);
    const clearIdxB = calls.indexOf(`repo.clearMachineOwner:${MACHINE_B}`);
    const archiveIdxB = calls.indexOf(`archiver.archive:${MACHINE_B}`);
    const terminateIdxB = calls.indexOf(`sessionTerminator.terminateForMachine:${MACHINE_B}`);
    expect(stopIdxB).toBeGreaterThan(terminateIdx);
    expect(clearIdxB).toBeGreaterThan(stopIdxB);
    expect(archiveIdxB).toBeGreaterThan(clearIdxB);
    expect(terminateIdxB).toBeGreaterThan(archiveIdxB);

    // machine.offboarded fires once per machine, after that machine's archive.
    const offboardedEvents = calls.filter((c) => c.startsWith("event:machine.offboarded"));
    expect(offboardedEvents).toHaveLength(2);
    expect(calls.indexOf("event:machine.offboarded")).toBeGreaterThan(-1);

    // access.certificate_revoked fired once per cert, machine.stopped/owner_cleared once per machine.
    expect(calls.filter((c) => c === "event:access.certificate_revoked")).toHaveLength(2);
    expect(calls.filter((c) => c === "event:machine.stopped")).toHaveLength(2);
    expect(calls.filter((c) => c === "event:machine.owner_cleared")).toHaveLength(2);
  });

  test("one machine's failure is isolated: the other owned machine is still fully offboarded", async () => {
    const calls: string[] = [];
    const layers = buildTestLayers({
      approvalStatus: "approved",
      calls,
      failArchiveForMachine: MACHINE_A,
    });

    const outcome = await Effect.runPromise(
      Effect.provide(
        offboardPersonDetailed(PERSON_ID, REQUESTED_BY, "leaving the company"),
        layers,
      ),
    );

    expect(outcome.machinesOffboarded).toEqual([MACHINE_B]);
    expect(outcome.machineFailures).toHaveLength(1);
    expect(outcome.machineFailures[0]?.machineId).toBe(MACHINE_A);

    // Certs were still revoked once for the whole person, regardless of A's failure.
    expect(calls.filter((c) => c === "event:access.certificate_revoked")).toHaveLength(2);
    // Machine A got as far as stop + clear owner before its archive failed, and never
    // reached the session-terminator step that only runs after a successful archive.
    expect(calls).toContain(`provisioning.archive:${MACHINE_A}`);
    expect(calls).toContain(`repo.clearMachineOwner:${MACHINE_A}`);
    expect(calls).not.toContain(`sessionTerminator.terminateForMachine:${MACHINE_A}`);
    // ...but machine B was still attempted and fully completed afterward.
    expect(calls).toContain(`archiver.archive:${MACHINE_B}`);
    expect(calls).toContain(`sessionTerminator.terminateForMachine:${MACHINE_B}`);
    expect(calls.filter((c) => c === "event:machine.offboarded")).toHaveLength(1);
  });

  test("denied approval halts the entire sequence: no certs revoked, no machine touched", async () => {
    const calls: string[] = [];
    const layers = buildTestLayers({ approvalStatus: "rejected", calls });

    const outcome = await Effect.runPromise(
      Effect.provide(
        offboardPersonDetailed(PERSON_ID, REQUESTED_BY, "leaving the company"),
        layers,
      ),
    );

    expect(outcome.status).toBe("rejected");
    expect(outcome.machinesOffboarded).toEqual([]);

    // Only the person lookup and the approval request itself ran.
    expect(calls).toEqual(["repo.findPerson", "approval.request"]);
  });

  test("pending approval also halts the sequence as a no-op", async () => {
    const calls: string[] = [];
    const layers = buildTestLayers({ approvalStatus: "pending", calls });

    await Effect.runPromise(
      Effect.provide(
        offboardPersonDetailed(PERSON_ID, REQUESTED_BY, "leaving the company"),
        layers,
      ),
    );

    expect(calls).toEqual(["repo.findPerson", "approval.request"]);
  });

  test("unknown person fails without ever requesting approval", async () => {
    const calls: string[] = [];
    const layers = buildTestLayers({ approvalStatus: "approved", calls });

    const error = await Effect.runPromise(
      Effect.provide(offboardPersonDetailed("does-not-exist", REQUESTED_BY, "reason"), layers).pipe(
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(OffboardingError);
    expect((error as OffboardingError).reason).toBe("person_not_found");
    expect(calls).toEqual(["repo.findPerson"]);
  });

  test("offboardPerson (the void-returning entry point) succeeds on approval and resolves to undefined", async () => {
    const calls: string[] = [];
    const layers = buildTestLayers({ approvalStatus: "approved", calls });

    const result = await Effect.runPromise(
      Effect.provide(offboardPerson(PERSON_ID, REQUESTED_BY, "leaving the company"), layers),
    );

    expect(result).toBeUndefined();
    expect(calls).toContain(`archiver.archive:${MACHINE_A}`);
  });
});

describe("resumeOffboarding", () => {
  test("still pending: no-op, no certs revoked, no machine touched", async () => {
    const calls: string[] = [];
    const layers = buildTestLayers({
      approvalStatus: "approved", // irrelevant here — resumeOffboarding reads .status(), not this
      calls,
      statusResult: { status: "pending" },
    });

    const outcome = await Effect.runPromise(
      Effect.provide(resumeOffboarding("approval-1", ORG_ID), layers),
    );

    expect(outcome.status).toBe("pending");
    expect(outcome.machinesOffboarded).toEqual([]);
    expect(calls).toEqual(["approval.status"]);
  });

  test("now approved: runs the exact same revoke -> per-machine sequence as the immediate path", async () => {
    const calls: string[] = [];
    const layers = buildTestLayers({
      approvalStatus: "pending",
      calls,
      statusResult: { status: "approved" },
    });

    const outcome = await Effect.runPromise(
      Effect.provide(resumeOffboarding("approval-1", ORG_ID), layers),
    );

    expect(outcome.status).toBe("approved");
    expect(outcome.machinesOffboarded).toEqual([MACHINE_A, MACHINE_B]);
    expect(calls.filter((c) => c === "event:access.certificate_revoked")).toHaveLength(2);
    expect(calls.filter((c) => c === "event:machine.offboarded")).toHaveLength(2);
  });

  test("rejects an approval that isn't an offboarding approval, or has no targetPersonId", async () => {
    const calls: string[] = [];
    const layers = buildTestLayers({
      approvalStatus: "approved",
      calls,
      statusResult: { actionType: "admin_access", targetPersonId: null },
    });

    const error = await Effect.runPromise(
      Effect.provide(resumeOffboarding("approval-1", ORG_ID), layers).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(OffboardingError);
    expect((error as OffboardingError).reason).toBe("invalid_approval");
    // Never even looked up a person or touched anything.
    expect(calls).toEqual(["approval.status"]);
  });
});
