import { events, certificates } from "@cloudable/schema";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../../domain/compliance/types";
import { clearResolvedFindings, upsertFindingFirstSeen } from "../finding-store";

export const CHECK_ID = "access-revoked-on-offboarding";

const OFFBOARDING_GRACE_MS = 24 * 60 * 60 * 1000;

/** Matches `MachineEvent`'s `machine.offboarded` payload in `@cloudable/events`. */
interface MachineOffboardedPayload {
  previousOwnerId: string;
  approvalId: string;
}

/**
 * A certificate's `machineScope` (see `packages/schema/src/tables/
 * certificate.ts`) is either the literal string `"all"` or a list of
 * machine ids. Only resolve to a concrete `machineId` when the scope names
 * exactly one machine — anything broader can't be attributed to a single
 * machine without guessing.
 */
const resolveMachineId = (machineScope: unknown): string | null => {
  if (
    Array.isArray(machineScope) &&
    machineScope.length === 1 &&
    typeof machineScope[0] === "string"
  ) {
    return machineScope[0];
  }
  return null;
};

/**
 * "Access revoked on offboarding" — the first of the v1 checks, and the one
 * every other check's registry/finding-age/control-mapping shape gets
 * validated against, so its `ComplianceFinding`/finding-store usage is
 * meant to be the pattern the other checks copy.
 *
 * Fails when a certificate is still valid 24h after its owner was
 * offboarded. "Still valid" is read directly off the `certificates` table
 * (`revokedAt IS NULL` and `expiresAt > now`) — that table, not the
 * `access.certificate_issued`/`access.certificate_revoked` events, is the
 * live source of truth for a certificate's current status; the events are
 * the audit trail of how it got there.
 */
export const accessRevokedOnOffboardingCheck: ComplianceCheck = {
  id: CHECK_ID,
  label: "Access revoked on offboarding",
  // Live, unrevoked SSH access surviving an offboarding is a direct
  // unauthorised-access risk — the highest severity among the six checks.
  severity: "high",
  controlRefs: ["access-management"],

  // Not applicable to an org that has never issued a single certificate —
  // "access revoked on offboarding" presumes there was ever any SSH-certificate
  // access to revoke in the first place. A `pass` for an org that has never
  // touched this feature is a false reassurance, not a real result — "a
  // dashboard full of N/A" is the thing to avoid, but a false `pass` for a
  // feature never exercised is worse, not better.
  appliesTo: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const rows = yield* Effect.tryPromise(() =>
        db
          .select({ id: certificates.id })
          .from(certificates)
          .where(eq(certificates.orgId, orgId))
          .limit(1),
      ).pipe(Effect.orDie);
      return rows.length > 0;
    }),

  evaluate: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const now = new Date();

      const offboardedEvents = yield* Effect.tryPromise(() =>
        db
          .select({ occurredAt: events.occurredAt, payload: events.payload })
          .from(events)
          .where(and(eq(events.orgId, orgId), eq(events.type, "machine.offboarded"))),
      ).pipe(Effect.orDie);

      // A person can be offboarded more than once (re-onboarded, then
      // offboarded again) — only the most recent offboarding reflects
      // whether they currently should have no live access.
      const lastOffboardedAtByPerson = new Map<string, Date>();
      for (const row of offboardedEvents) {
        const { previousOwnerId } = row.payload as MachineOffboardedPayload;
        if (!previousOwnerId) continue;
        const current = lastOffboardedAtByPerson.get(previousOwnerId);
        if (!current || row.occurredAt > current) {
          lastOffboardedAtByPerson.set(previousOwnerId, row.occurredAt);
        }
      }

      // Only people whose most recent offboarding has already cleared the
      // 24h grace window are candidates at all.
      const qualifyingPersonIds: string[] = [];
      for (const [personId, offboardedAt] of lastOffboardedAtByPerson) {
        if (now.getTime() - offboardedAt.getTime() > OFFBOARDING_GRACE_MS) {
          qualifyingPersonIds.push(personId);
        }
      }

      const findings: ComplianceFinding[] = [];
      const openCertificateIds: string[] = [];

      if (qualifyingPersonIds.length > 0) {
        // One query for every qualifying person's still-valid certificates,
        // rather than one query per person.
        const staleCertificates = yield* Effect.tryPromise(() =>
          db
            .select()
            .from(certificates)
            .where(
              and(
                eq(certificates.orgId, orgId),
                inArray(certificates.personId, qualifyingPersonIds),
                isNull(certificates.revokedAt),
                gt(certificates.expiresAt, now),
              ),
            ),
        ).pipe(Effect.orDie);

        for (const cert of staleCertificates) {
          // Always defined: `cert.personId` came from `qualifyingPersonIds`,
          // which is built from this same map's keys.
          const offboardedAt = lastOffboardedAtByPerson.get(cert.personId) as Date;

          // A certificate issued AFTER the offboarding it's being checked
          // against isn't a revocation failure — it's unrelated access
          // granted later (e.g. the person was rehired and issued a fresh
          // certificate). Only a certificate that existed at the time of
          // offboarding and was never revoked is evidence of a missed
          // revocation.
          if (cert.issuedAt > offboardedAt) continue;

          openCertificateIds.push(cert.id);
          const machineId = resolveMachineId(cert.machineScope);

          const firstSeenAt = yield* upsertFindingFirstSeen({
            checkId: CHECK_ID,
            orgId,
            machineId,
            detailKey: cert.id,
          }).pipe(Effect.orDie);

          findings.push({
            checkId: CHECK_ID,
            orgId,
            machineId,
            firstSeenAt,
            detail: {
              certificateId: cert.id,
              offboardedAt: offboardedAt.toISOString(),
              personId: cert.personId,
            },
          });
        }
      }

      // Anything previously open for this check+org that isn't among the
      // certificates found just now has resolved (revoked, expired, or the
      // owner's offboarding event no longer qualifies) — stop aging it.
      yield* clearResolvedFindings(CHECK_ID, orgId, openCertificateIds).pipe(Effect.orDie);

      return findings;
    }),
};
