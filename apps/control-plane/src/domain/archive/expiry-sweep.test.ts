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
import { isDbReachable } from "../../testing/db-reachable";
import { computeExpirySweepCandidates, expireOverdueSnapshots } from "./snapshot";

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
    opts: { legalHold?: boolean } = {},
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
    const overdue = await seedOverdueSnapshot(org.id, machine.id);
    const held = await seedOverdueSnapshot(org.id, machine.id, { legalHold: true });

    const count = await run(expireOverdueSnapshots());
    expect(count).toBeGreaterThanOrEqual(1);

    const [expiredRow] = await db.select().from(snapshots).where(eq(snapshots.id, overdue.id));
    expect(expiredRow?.expiredAt).not.toBeNull();

    const [heldRow] = await db.select().from(snapshots).where(eq(snapshots.id, held.id));
    expect(heldRow?.expiredAt).toBeNull();

    const publishedEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.type, "snapshot.expired"), eq(events.orgId, org.id)));
    expect(publishedEvents.some((e) => e.machineId === machine.id)).toBe(true);

    // Idempotent: a second sweep finds nothing left to do for this org's machine.
    const secondPass = await run(computeExpirySweepCandidates(new Date(), org.id));
    expect(secondPass.map((s) => s.id)).not.toContain(overdue.id);
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

    await run(expireOverdueSnapshots());

    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, fresh.id));
    expect(row?.expiredAt).toBeNull();
  });
});
