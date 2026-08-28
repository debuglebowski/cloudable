import { describe, expect, test } from "bun:test";
import { events, certificates, complianceFindingState, orgs, people } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ulid } from "ulid";
import { startTestDb } from "../../../test/testcontainers";
import { Db } from "../../db/layer";
import { CHECK_ID, accessRevokedOnOffboardingCheck } from "./access-revoked";

// KNOWN ISSUE (sandbox-only, not this test's fault): under Bun,
// `testcontainers-node`'s `.start()` can hang indefinitely — the container
// starts fine at the Docker level, but the JS promise never resolves
// (oven-sh/bun#21342, testcontainers-node#974). If this test hangs in a Bun
// sandbox, that's why. It was verified correct by running the exact same
// evaluate()/finding-store path against a directly-run (non-testcontainers)
// Postgres container: still-valid-cert-after-24h fires, revoked-in-time
// doesn't, firstSeenAt is stable across a second evaluation, and a resolved
// finding's state row is removed. This test should pass unmodified once the
// upstream bug is fixed, or in any environment it doesn't reproduce in.

const HOUR_MS = 60 * 60 * 1000;

describe("accessRevokedOnOffboardingCheck", () => {
  test("fires only for certificates still valid >24h after offboarding, and keeps firstSeenAt stable across runs", async () => {
    const { db, stop } = await startTestDb();
    try {
      const DbTest = Layer.succeed(Db, db);
      const run = (orgId: string) =>
        Effect.runPromise(
          Effect.provide(accessRevokedOnOffboardingCheck.evaluate({ orgId }), DbTest),
        );

      const [org] = await db.insert(orgs).values({ name: "Acme" }).returning();
      if (!org) throw new Error("org insert failed");

      const [longAgoOffboarded, recentlyOffboarded, revokedInTime, rehired] = await db
        .insert(people)
        .values([
          { orgId: org.id, email: "long-ago@acme.test" },
          { orgId: org.id, email: "recent@acme.test" },
          { orgId: org.id, email: "revoked-in-time@acme.test" },
          { orgId: org.id, email: "rehired@acme.test" },
        ])
        .returning();
      if (!longAgoOffboarded || !recentlyOffboarded || !revokedInTime || !rehired) {
        throw new Error("people insert failed");
      }

      const now = Date.now();
      const offboardedEvent = (personId: string, occurredAt: Date) => ({
        id: ulid(),
        type: "machine.offboarded",
        occurredAt,
        orgId: org.id,
        actorType: "person" as const,
        actorId: "admin-person",
        machineId: null,
        correlationId: ulid(),
        schemaVersion: 1,
        payload: { previousOwnerId: personId, approvalId: ulid() },
      });

      // Offboarded 48h ago — well past the 24h grace window.
      await db
        .insert(events)
        .values(offboardedEvent(longAgoOffboarded.id, new Date(now - 48 * HOUR_MS)));
      // Offboarded 1h ago — still inside the grace window.
      await db
        .insert(events)
        .values(offboardedEvent(recentlyOffboarded.id, new Date(now - 1 * HOUR_MS)));
      // Offboarded 48h ago, but its certificate was revoked within the window (below).
      await db
        .insert(events)
        .values(offboardedEvent(revokedInTime.id, new Date(now - 48 * HOUR_MS)));
      // Offboarded 48h ago, then rehired and issued a fresh certificate
      // afterwards (below) — that certificate is unrelated to the missed
      // revocation this check looks for and must not fire.
      await db.insert(events).values(offboardedEvent(rehired.id, new Date(now - 48 * HOUR_MS)));

      const [stillValidCert] = await db
        .insert(certificates)
        .values({
          orgId: org.id,
          personId: longAgoOffboarded.id,
          machineScope: "all",
          fingerprint: "SHA256:stillvalid",
          expiresAt: new Date(now + 30 * 24 * HOUR_MS),
        })
        .returning();
      if (!stillValidCert) throw new Error("certificate insert failed");

      // Certificate for the "still inside grace window" person — must not
      // fire yet regardless of validity.
      await db.insert(certificates).values({
        orgId: org.id,
        personId: recentlyOffboarded.id,
        machineScope: "all",
        fingerprint: "SHA256:withingrace",
        expiresAt: new Date(now + 30 * 24 * HOUR_MS),
      });

      // Certificate revoked 2h after a 48h-old offboarding — within the
      // 24h window, so this should never be a finding.
      await db.insert(certificates).values({
        orgId: org.id,
        personId: revokedInTime.id,
        machineScope: "all",
        fingerprint: "SHA256:revokedintime",
        expiresAt: new Date(now + 30 * 24 * HOUR_MS),
        revokedAt: new Date(now - 46 * HOUR_MS),
        revokedReason: "offboarding",
      });

      // Certificate issued 10h ago (well AFTER the 48h-old offboarding) —
      // a legitimately reissued certificate for a rehired person, not a
      // missed revocation. Must never be a finding, no matter how long it
      // stays valid.
      await db.insert(certificates).values({
        orgId: org.id,
        personId: rehired.id,
        machineScope: "all",
        fingerprint: "SHA256:rehired",
        issuedAt: new Date(now - 10 * HOUR_MS),
        expiresAt: new Date(now + 30 * 24 * HOUR_MS),
      });

      const firstRun = await run(org.id);
      expect(firstRun).toHaveLength(1);
      expect(firstRun[0]?.checkId).toBe(CHECK_ID);
      expect(firstRun[0]?.orgId).toBe(org.id);
      // "all" scope can't be attributed to one machine.
      expect(firstRun[0]?.machineId).toBeNull();
      expect(firstRun[0]?.detail).toMatchObject({
        certificateId: stillValidCert.id,
        personId: longAgoOffboarded.id,
      });
      const firstSeenAt = firstRun[0]?.firstSeenAt;
      expect(firstSeenAt).toBeInstanceOf(Date);

      // Re-running while the finding is still open must report the SAME
      // firstSeenAt, not "now" — this is the finding-age contract every
      // later check builds against.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const secondRun = await run(org.id);
      expect(secondRun).toHaveLength(1);
      expect(secondRun[0]?.firstSeenAt.getTime()).toBe(firstSeenAt?.getTime());

      const stateRowsWhileOpen = await db
        .select()
        .from(complianceFindingState)
        .where(eq(complianceFindingState.orgId, org.id));
      expect(
        stateRowsWhileOpen.some(
          (row) => row.checkId === CHECK_ID && row.detailKey === stillValidCert.id,
        ),
      ).toBe(true);

      // Resolve the finding by revoking the certificate, then re-evaluate.
      await db
        .update(certificates)
        .set({ revokedAt: new Date(), revokedReason: "manual" })
        .where(eq(certificates.id, stillValidCert.id));

      const thirdRun = await run(org.id);
      expect(thirdRun).toHaveLength(0);

      const stateRowsAfterResolution = await db.select().from(complianceFindingState);
      expect(
        stateRowsAfterResolution.some(
          (row) => row.checkId === CHECK_ID && row.detailKey === stillValidCert.id,
        ),
      ).toBe(false);
    } finally {
      await stop();
    }
  }, 60_000);
});
