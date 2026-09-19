import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { events, machines, orgs, snapshots } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import {
  ProvisioningError,
  type ProvisioningService,
  ProvisioningServiceTag,
} from "../../services/ProvisioningService";
import { isDbReachable } from "../../testing/db-reachable";
import { computeExpirySweepCandidates, expireOverdueSnapshots } from "./snapshot";

/**
 * Records every disk id the sweep asked to destroy, and can be told to refuse one.
 *
 * The sweep's whole reason for existing is that it used to report a deletion it never
 * performed, so a provisioning double that silently succeeds would reproduce exactly the
 * bug under test. Asserting on `deleted` is the point.
 */
function recordingProvisioning(failFor: ReadonlySet<string> = new Set()) {
  const deleted: string[] = [];
  const service = {
    deleteSnapshotDisk: ({ diskExternalId }: { diskExternalId: string }) => {
      if (failFor.has(diskExternalId)) {
        return Effect.fail(
          new ProvisioningError({ reason: "provider_error", cause: "simulated delete failure" }),
        );
      }
      deleted.push(diskExternalId);
      return Effect.void;
    },
    create: () => Effect.die("not used in this test"),
    snapshot: () => Effect.die("not used in this test"),
    grantSnapshotRead: () => Effect.die("not used in this test"),
    revokeSnapshotRead: () => Effect.die("not used in this test"),
    snapshotDiskExists: () => Effect.die("not used in this test"),
    archive: () => Effect.die("not used in this test"),
    reconcile: () => Effect.die("not used in this test"),
    reimage: () => Effect.die("not used in this test"),
    restart: () => Effect.die("not used in this test"),
  } as unknown as ProvisioningService;
  return { deleted, layer: Layer.succeed(ProvisioningServiceTag, service) };
}

// Real Postgres — `expireOverdueSnapshots` and `computeExpirySweepCandidates` are plain
// SQL filters plus a real `EventBus.publish`, not meaningfully fakeable.
const databaseUrl = config.databaseUrl;
const dbReachable = await isDbReachable(databaseUrl);

describe.skipIf(!dbReachable)("expireOverdueSnapshots (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<Db | EventBus>;

  beforeAll(() => {
    sql = postgres(databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    TestLayer = Layer.mergeAll(dbLayer, Layer.provide(EventBus.Default, dbLayer));
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Db | EventBus>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  /** The sweep now needs a provider to delete through. Returns the recorder so a test can
   * assert on what was actually destroyed. */
  const runSweep = (failFor?: ReadonlySet<string>) => {
    const provisioning = recordingProvisioning(failFor);
    return {
      deleted: provisioning.deleted,
      result: Effect.runPromise(
        Effect.provide(expireOverdueSnapshots(), Layer.merge(TestLayer, provisioning.layer)),
      ),
    };
  };

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  }

  async function seedMachine(orgId: string) {
    const [machine] = await db
      .insert(machines)
      .values({
        orgId,
        name: "m1",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  /** Inserts a snapshot directly (bypassing `createSnapshot`, which always computes
   * `expiresAt` as `now + retentionDays` — no way to seed an already-overdue one
   * through the public API) with `expiresAt` in the past. */
  async function seedOverdueSnapshot(
    orgId: string,
    machineId: string,
    opts: { legalHold?: boolean; capturedDisks?: schema.CapturedDisk[] } = {},
  ) {
    const pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [snapshot] = await db
      .insert(snapshots)
      .values({
        orgId,
        machineId,
        trigger: "manual",
        region: "eastus",
        containsData: true,
        containsConfig: true,
        legalHold: opts.legalHold ?? false,
        capturedDisks: opts.capturedDisks ?? [],
        retentionDays: 30,
        expiresAt: pastExpiry,
        createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      })
      .returning();
    if (!snapshot) throw new Error("seed failed");
    return snapshot;
  }

  test("computeExpirySweepCandidates finds an overdue snapshot, excludes a legal-hold one, and scopes by orgId", async () => {
    const org = await seedOrg();
    const otherOrg = await seedOrg();
    const machine = await seedMachine(org.id);
    const overdue = await seedOverdueSnapshot(org.id, machine.id);
    await seedOverdueSnapshot(org.id, machine.id, { legalHold: true });

    const unscoped = await run(computeExpirySweepCandidates(new Date()));
    expect(unscoped.map((s) => s.id)).toContain(overdue.id);
    // Legal hold is excluded regardless of scope.
    expect(unscoped.every((s) => s.legalHold === false)).toBe(true);

    const scopedToOwnOrg = await run(computeExpirySweepCandidates(new Date(), org.id));
    expect(scopedToOwnOrg.map((s) => s.id)).toContain(overdue.id);

    const scopedToOtherOrg = await run(computeExpirySweepCandidates(new Date(), otherOrg.id));
    expect(scopedToOtherOrg.map((s) => s.id)).not.toContain(overdue.id);
  });

  test("expireOverdueSnapshots sets expiredAt, publishes snapshot.expired, and never touches a legal-hold snapshot", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id);
    const overdue = await seedOverdueSnapshot(org.id, machine.id, {
      capturedDisks: [{ kind: "os", externalId: `disk-os-${crypto.randomUUID()}`, sizeBytes: 100 }],
    });
    const held = await seedOverdueSnapshot(org.id, machine.id, { legalHold: true });

    const sweep = runSweep();
    const count = await sweep.result;
    expect(count).toBeGreaterThanOrEqual(1);

    // The disk was actually destroyed, not just marked. This is the assertion the whole
    // operation exists for.
    const overdueDiskId = overdue.capturedDisks[0]?.externalId as string;
    expect(sweep.deleted).toContain(overdueDiskId);

    const [expiredRow] = await db.select().from(snapshots).where(eq(snapshots.id, overdue.id));
    expect(expiredRow?.expiredAt).not.toBeNull();

    const [heldRow] = await db.select().from(snapshots).where(eq(snapshots.id, held.id));
    expect(heldRow?.expiredAt).toBeNull();

    const publishedEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.type, "snapshot.expired"), eq(events.orgId, org.id)));
    expect(publishedEvents.some((e) => e.machineId === machine.id)).toBe(true);
    // The event names what it destroyed rather than merely asserting that it did.
    const expiredEvent = publishedEvents.find(
      (e) => (e.payload as { deletedDiskExternalIds?: string[] }).deletedDiskExternalIds?.length,
    );
    expect(
      (expiredEvent?.payload as { deletedDiskExternalIds: string[] }).deletedDiskExternalIds,
    ).toContain(overdueDiskId);

    // Idempotent: a second sweep finds nothing left to do for this org's machine.
    const secondPass = await run(computeExpirySweepCandidates(new Date(), org.id));
    expect(secondPass.map((s) => s.id)).not.toContain(overdue.id);
  });

  test("a snapshot whose disk could not be destroyed is left overdue, with no event", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id);
    const doomedDisk = `disk-fail-${crypto.randomUUID()}`;
    const overdue = await seedOverdueSnapshot(org.id, machine.id, {
      capturedDisks: [{ kind: "os", externalId: doomedDisk, sizeBytes: 100 }],
    });

    await runSweep(new Set([doomedDisk])).result;

    // Still overdue. Compliance check #5 reads exactly this, so it correctly stays red
    // while data that should be gone is still sitting at the provider.
    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, overdue.id));
    expect(row?.expiredAt).toBeNull();

    const published = await db
      .select()
      .from(events)
      .where(and(eq(events.type, "snapshot.expired"), eq(events.orgId, org.id)));
    expect(published).toHaveLength(0);

    // And a later pass, once the provider cooperates, finishes the job.
    const retry = runSweep();
    await retry.result;
    expect(retry.deleted).toContain(doomedDisk);
    const [afterRetry] = await db.select().from(snapshots).where(eq(snapshots.id, overdue.id));
    expect(afterRetry?.expiredAt).not.toBeNull();
  });

  test("a partially deleted snapshot is not expired, and the retry re-runs the disk that already succeeded", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id);
    const okDisk = `disk-ok-${crypto.randomUUID()}`;
    const badDisk = `disk-bad-${crypto.randomUUID()}`;
    const overdue = await seedOverdueSnapshot(org.id, machine.id, {
      capturedDisks: [
        { kind: "os", externalId: okDisk, sizeBytes: 100 },
        { kind: "data", externalId: badDisk, sizeBytes: 200 },
      ],
    });

    const firstPass = runSweep(new Set([badDisk]));
    await firstPass.result;
    expect(firstPass.deleted).toEqual([okDisk]);

    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, overdue.id));
    expect(row?.expiredAt).toBeNull();

    // The retry re-issues the delete for the disk that already succeeded. That is only
    // safe because the operation is idempotent, which is why the port requires it.
    const secondPass = runSweep();
    await secondPass.result;
    expect(secondPass.deleted).toEqual([okDisk, badDisk]);
    const [afterRetry] = await db.select().from(snapshots).where(eq(snapshots.id, overdue.id));
    expect(afterRetry?.expiredAt).not.toBeNull();
  });

  test("a row that captured nothing expires with an empty deleted list, claiming no deletion", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id);
    // The shape of the six rows in production written before snapshots captured real ids.
    const legacy = await seedOverdueSnapshot(org.id, machine.id, { capturedDisks: [] });

    const sweep = runSweep();
    await sweep.result;
    expect(sweep.deleted).toHaveLength(0);

    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, legacy.id));
    expect(row?.expiredAt).not.toBeNull();

    const published = await db
      .select()
      .from(events)
      .where(and(eq(events.type, "snapshot.expired"), eq(events.orgId, org.id)));
    expect(
      (published[0]?.payload as { deletedDiskExternalIds: string[] }).deletedDiskExternalIds,
    ).toEqual([]);
  });

  test("expireOverdueSnapshots is a no-op when nothing is overdue", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id);
    // A snapshot whose retention window hasn't elapsed — not seeded as overdue.
    const [fresh] = await db
      .insert(snapshots)
      .values({
        orgId: org.id,
        machineId: machine.id,
        trigger: "manual",
        region: "eastus",
        containsData: true,
        containsConfig: true,
        legalHold: false,
        retentionDays: 30,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning();
    if (!fresh) throw new Error("seed failed");

    await runSweep().result;

    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, fresh.id));
    expect(row?.expiredAt).toBeNull();
  });
});
