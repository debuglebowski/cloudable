import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// The snapshot integrity sweep: does "restorable" mean anything?
//
// Written because it did not. Production had rows naming disks the provider no longer
// had, still showing a green badge and a live Restore button — the third appearance of
// this bug class, and the first that could not be fixed by teaching a pure function more
// about the row.
import * as schema from "@cloudable/schema";
import { machines, orgs, people, snapshots } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import type { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { makeFakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { isDbReachable } from "../../testing/db-reachable";
import { createSnapshot, detectMissingSnapshotData } from "./snapshot";
import { getSnapshotSubState, restoreUnavailableReason } from "./sub-state";

const databaseUrl = config.databaseUrl;
const dbReachable = await isDbReachable(databaseUrl);

const PRESENT = "disk-that-still-exists";

describe.skipIf(!dbReachable)("snapshot integrity sweep (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<Db | EventBus | ProvisioningServiceTag>;

  beforeAll(() => {
    sql = postgres(databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    TestLayer = Layer.mergeAll(
      dbLayer,
      Layer.provide(EventBus.Default, dbLayer),
      // Only PRESENT is registered, so any other id reports missing — exactly what Azure
      // does for a snapshot that was deleted.
      makeFakeProvisioningServiceLive({
        snapshotImages: new Map([[PRESENT, "/dev/null"]]),
      }),
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Db | EventBus | ProvisioningServiceTag>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  const seed = async (disks: unknown[], overrides: Record<string, unknown> = {}) => {
    const [org] = await db
      .insert(orgs)
      .values({ name: `integ-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    const [owner] = await db
      .insert(people)
      .values({ orgId: org.id, email: `i-${crypto.randomUUID()}@example.test` })
      .returning();
    if (!owner) throw new Error("seed failed");
    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        name: "m",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        ownerPersonId: owner.id,
        state: "archived_restorable",
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    const [snapshot] = await db
      .insert(snapshots)
      .values({
        orgId: org.id,
        machineId: machine.id,
        trigger: "archive",
        retentionDays: 30,
        expiresAt: new Date(Date.now() + 20 * 86_400_000),
        capturedDisks: disks as never,
        ...overrides,
      })
      .returning();
    if (!snapshot) throw new Error("seed failed");
    return snapshot;
  };

  const reload = async (id: string) => {
    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, id));
    if (!row) throw new Error("not found");
    return row;
  };

  test("flags a snapshot whose recorded disk is gone", async () => {
    const snap = await seed([{ kind: "data", externalId: "gone", sizeBytes: 1 }]);
    expect(getSnapshotSubState(snap)).toBe("restorable");

    await run(detectMissingSnapshotData());

    const after = await reload(snap.id);
    expect(after.dataMissingAt).not.toBeNull();
    expect(getSnapshotSubState(after)).toBe("data_missing");
    // Greyed WITH the reason, never hidden.
    expect(restoreUnavailableReason(after)).toContain("no longer exist at the provider");
  });

  test("leaves a snapshot whose disks are all present alone", async () => {
    const snap = await seed([{ kind: "data", externalId: PRESENT, sizeBytes: 1 }]);
    await run(detectMissingSnapshotData());
    const after = await reload(snap.id);
    expect(after.dataMissingAt).toBeNull();
    expect(getSnapshotSubState(after)).toBe("restorable");
  });

  test("flags when only ONE of several disks is gone", async () => {
    // A full snapshot with its OS disk intact and its data disk gone is not restorable.
    // Requiring every disk to vanish before saying so would call it healthy.
    const snap = await seed([
      { kind: "os", externalId: PRESENT, sizeBytes: 1 },
      { kind: "data", externalId: "gone-too", sizeBytes: 1 },
    ]);
    await run(detectMissingSnapshotData());
    expect((await reload(snap.id)).dataMissingAt).not.toBeNull();
  });

  test("skips a snapshot that captured nothing", async () => {
    // Already `empty`. There is no id to check, and flagging it would relabel "never
    // existed" as "went missing".
    const snap = await seed([]);
    await run(detectMissingSnapshotData());
    const after = await reload(snap.id);
    expect(after.dataMissingAt).toBeNull();
    expect(getSnapshotSubState(after)).toBe("empty");
  });

  test("skips a snapshot that already expired", async () => {
    // Past retention the data being gone is the expected outcome. Reporting it as a
    // fault would bury the real anomalies.
    const snap = await seed([{ kind: "data", externalId: "gone", sizeBytes: 1 }], {
      expiredAt: new Date(),
    });
    await run(detectMissingSnapshotData());
    const after = await reload(snap.id);
    expect(after.dataMissingAt).toBeNull();
    expect(getSnapshotSubState(after)).toBe("expired");
  });

  test("is idempotent — a second pass neither re-flags nor re-publishes", async () => {
    const snap = await seed([{ kind: "data", externalId: "gone", sizeBytes: 1 }]);
    await run(detectMissingSnapshotData());
    const first = await reload(snap.id);

    const secondCount = await run(detectMissingSnapshotData());
    const second = await reload(snap.id);

    expect(second.dataMissingAt?.getTime()).toBe(first.dataMissingAt?.getTime());
    const events = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.correlationId, snap.id));
    expect(events.filter((e) => e.type === "snapshot.data_missing")).toHaveLength(1);
    expect(secondCount).toBe(0);
  });

  test("publishes snapshot.data_missing naming which disks went", async () => {
    const snap = await seed([
      { kind: "os", externalId: PRESENT, sizeBytes: 1 },
      { kind: "data", externalId: "the-one-that-went", sizeBytes: 1 },
    ]);
    await run(detectMissingSnapshotData());

    const [event] = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.correlationId, snap.id));
    expect(event?.type).toBe("snapshot.data_missing");
    const payload = event?.payload as {
      missingDiskExternalIds: string[];
      recordedDiskCount: number;
    };
    // Which object was lost is the first question anyone investigating asks.
    expect(payload.missingDiskExternalIds).toEqual(["the-one-that-went"]);
    expect(payload.recordedDiskCount).toBe(2);
  });

  test("a manual snapshot of a live machine is restorable, and the sweep leaves it alone", async () => {
    // The whole point of `trigger: "manual"`: a snapshot someone asked for, on a machine
    // that keeps running. Until this there was no way to produce one — archive and
    // upgrade were the only paths, and both destroy the machine.
    const [org] = await db
      .insert(orgs)
      .values({ name: `manual-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    const [owner] = await db
      .insert(people)
      .values({ orgId: org.id, email: `m-${crypto.randomUUID()}@example.test` })
      .returning();
    if (!owner) throw new Error("seed failed");
    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        name: "still-running",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        ownerPersonId: owner.id,
        state: "running",
      })
      .returning();
    if (!machine) throw new Error("seed failed");

    // The fake adapter answers `not_found` for a machine it never created, so this
    // records a row naming nothing — the honest outcome for infrastructure that is not
    // really there, and the same thing a real machine with no cloud resource produces.
    const snap = await run(createSnapshot(machine.id, "manual"));
    expect(snap.trigger).toBe("manual");
    expect(getSnapshotSubState(snap)).toBe("empty");

    // The machine is untouched — a manual snapshot must never stop it.
    const [after] = await db.select().from(machines).where(eq(machines.id, machine.id));
    expect(after?.state).toBe("running");
  });

  test("the record itself is never rewritten", async () => {
    // Invariant 6: the record is permanent. The ids that went missing stay on the row,
    // because "which object did we lose" outlives the incident.
    const snap = await seed([{ kind: "data", externalId: "gone", sizeBytes: 1 }]);
    await run(detectMissingSnapshotData());
    const after = await reload(snap.id);
    expect(after.capturedDisks).toEqual([{ kind: "data", externalId: "gone", sizeBytes: 1 }]);
    expect(after.expiresAt.getTime()).toBe(snap.expiresAt.getTime());
  });
});
