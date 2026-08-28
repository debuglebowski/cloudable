import { events, approvals } from "@cloudable/schema";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import type { ComplianceCheck, ComplianceFinding } from "../../domain/compliance/types";
import { upsertFindingFirstSeen } from "../finding-store";

const CHECK_ID = "elevated-access-approved";

/** Shape of the `access.elevation_granted` event payload we read. */
interface ElevationGrantedPayload {
  approvalId?: string;
}

/**
 * Check #4 — "Elevated access was approved" (`docs/spec.md` §19).
 *
 * Fails when a break-glass or admin session (an `access.elevation_granted`
 * event) has no approval record and reason. Two independent things have to
 * hold for an elevation to be clean:
 *
 * 1. A real approval flow ran for it — an `approval.granted` event shares
 *    the elevation's `correlationId` (the envelope field that links every
 *    event produced by one operation).
 * 2. That approval was actually reasoned — the `approvals` row referenced by
 *    the elevation's `approvalId` payload field has a non-empty `reason`.
 *
 * Missing either is a finding.
 */
export const elevatedAccessApprovedCheck: ComplianceCheck = {
  id: CHECK_ID,
  label: "Elevated access was approved",
  controlRefs: ["access-management"],
  appliesTo: () => Effect.succeed(true),
  evaluate: ({ orgId }) =>
    Effect.gen(function* () {
      const db = yield* Db;

      const elevationEvents = yield* Effect.tryPromise(() =>
        db
          .select()
          .from(events)
          .where(and(eq(events.orgId, orgId), eq(events.type, "access.elevation_granted"))),
      ).pipe(Effect.orDie);

      if (elevationEvents.length === 0) return [];

      const grantedApprovalEvents = yield* Effect.tryPromise(() =>
        db
          .select({ correlationId: events.correlationId })
          .from(events)
          .where(and(eq(events.orgId, orgId), eq(events.type, "approval.granted"))),
      ).pipe(Effect.orDie);
      const approvedCorrelationIds = new Set(grantedApprovalEvents.map((row) => row.correlationId));

      const approvalIds = Array.from(
        new Set(
          elevationEvents
            .map((event) => (event.payload as ElevationGrantedPayload).approvalId)
            .filter((id): id is string => Boolean(id)),
        ),
      );

      let reasonByApprovalId = new Map<string, string>();
      if (approvalIds.length > 0) {
        const approvalRows = yield* Effect.tryPromise(() =>
          db
            .select({ id: approvals.id, reason: approvals.reason })
            .from(approvals)
            .where(and(eq(approvals.orgId, orgId), inArray(approvals.id, approvalIds))),
        ).pipe(Effect.orDie);
        reasonByApprovalId = new Map(approvalRows.map((row) => [row.id, row.reason]));
      }

      const findings: ComplianceFinding[] = [];
      for (const event of elevationEvents) {
        const approvalId = (event.payload as ElevationGrantedPayload).approvalId;

        const missingApproval = !approvedCorrelationIds.has(event.correlationId);
        const reason = approvalId ? reasonByApprovalId.get(approvalId) : undefined;
        const missingReason = !reason || reason.trim().length === 0;

        if (!missingApproval && !missingReason) continue;

        const firstSeenAt = yield* upsertFindingFirstSeen({
          checkId: CHECK_ID,
          orgId,
          machineId: event.machineId,
          detailKey: event.id,
        }).pipe(Effect.orDie);

        findings.push({
          checkId: CHECK_ID,
          orgId,
          machineId: event.machineId,
          firstSeenAt,
          detail: { elevationEventId: event.id, missingReason, missingApproval },
        });
      }

      return findings;
    }),
};
