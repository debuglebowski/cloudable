// Real Postgres (not testcontainers, which hangs in this sandbox — see the sibling
// `*.integration-check.ts` files' own comments, and `docs/access.md`/`docs/lifecycle.md`).
// `appliesTo` for each check below is a plain SQL existence check, not meaningfully
// fakeable — this is the piece newly widened to require `Db` (see
// `domain/compliance/types.ts`) and, before this unit, every one of these was a hardcoded
// `Effect.succeed(true)` that never actually queried anything.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { certificates, machines, orgs, snapshots } from "@cloudable/schema";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { ulid } from "ulid";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { isDbReachable } from "../../testing/db-reachable";
import { accessRevokedOnOffboardingCheck } from "./access-revoked";
import { activeOwnerCheck } from "./active-owner";
import { elevatedAccessApprovedCheck } from "./elevated-access-approved";
import { noUndeclaredSoftwareCheck } from "./no-undeclared-software";
import { retentionHonouredCheck } from "./retention-honoured";

const databaseUrl = config.databaseUrl;
const dbReachable = await isDbReachable(databaseUrl);

describe.skipIf(!dbReachable)("compliance checks: appliesTo (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<Db>;

  beforeAll(() => {
    sql = postgres(databaseUrl);
    db = drizzle(sql, { schema });
    TestLayer = Layer.succeed(Db, db);
  });

  afterAll(async () => {
    await sql.end();
  });

  const appliesTo = (
    check: { appliesTo: (ctx: { orgId: string }) => Effect.Effect<boolean, never, Db> },
    orgId: string,
  ) => Effect.runPromise(Effect.provide(check.appliesTo({ orgId }), TestLayer));

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `applies-to-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  }

  async function seedLiveMachine(orgId: string) {
    const [machine] = await db
      .insert(machines)
      .values({
        orgId,
        name: "m1",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        state: "running",
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  test("access-revoked-on-offboarding: not applicable for an org with zero certificates, applicable once it has one", async () => {
    const org = await seedOrg();
    expect(await appliesTo(accessRevokedOnOffboardingCheck, org.id)).toBe(false);

    await db.insert(certificates).values({
      orgId: org.id,
      personId: crypto.randomUUID(),
      machineScope: "all",
      fingerprint: "SHA256:fake",
      expiresAt: new Date(Date.now() + 3600_000),
    });

    expect(await appliesTo(accessRevokedOnOffboardingCheck, org.id)).toBe(true);
  });

  test("active-owner: not applicable for an org with zero live machines, applicable once it has one", async () => {
    const org = await seedOrg();
    expect(await appliesTo(activeOwnerCheck, org.id)).toBe(false);

    await seedLiveMachine(org.id);

    expect(await appliesTo(activeOwnerCheck, org.id)).toBe(true);
  });

  test("active-owner: an org with only archived machines is still not applicable", async () => {
    const org = await seedOrg();
    await db.insert(machines).values({
      orgId: org.id,
      name: "archived-m1",
      provider: "fake",
      region: "eastus",
      sizeSku: "Standard_B2s",
      image: "ubuntu-24.04",
      state: "archived_restorable",
    });

    expect(await appliesTo(activeOwnerCheck, org.id)).toBe(false);
  });

  test("no-undeclared-software: not applicable for an org with zero live machines, applicable once it has one", async () => {
    const org = await seedOrg();
    expect(await appliesTo(noUndeclaredSoftwareCheck, org.id)).toBe(false);

    await seedLiveMachine(org.id);

    expect(await appliesTo(noUndeclaredSoftwareCheck, org.id)).toBe(true);
  });

  test("elevated-access-approved: not applicable for an org that has never granted elevated access, applicable once it has", async () => {
    const org = await seedOrg();
    expect(await appliesTo(elevatedAccessApprovedCheck, org.id)).toBe(false);

    const machine = await seedLiveMachine(org.id);
    await db.insert(schema.events).values({
      id: ulid(),
      type: "access.elevation_granted",
      occurredAt: new Date(),
      orgId: org.id,
      actorType: "person",
      actorId: "person-1",
      machineId: machine.id,
      correlationId: ulid(),
      schemaVersion: 1,
      payload: { level: "shell", expiresAt: new Date().toISOString(), approvalId: null },
    });

    expect(await appliesTo(elevatedAccessApprovedCheck, org.id)).toBe(true);
  });

  test("retention-honoured: not applicable for an org with zero snapshots, applicable once it has one", async () => {
    const org = await seedOrg();
    const machine = await seedLiveMachine(org.id);
    expect(await appliesTo(retentionHonouredCheck, org.id)).toBe(false);

    await db.insert(snapshots).values({
      orgId: org.id,
      machineId: machine.id,
      trigger: "manual",
      region: "eastus",
      containsData: true,
      containsConfig: true,
      legalHold: false,
      retentionDays: 30,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    expect(await appliesTo(retentionHonouredCheck, org.id)).toBe(true);
  });
});
