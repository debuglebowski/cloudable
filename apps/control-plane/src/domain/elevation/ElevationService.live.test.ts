import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { machines, notifications, orgs, people, settingValues } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { ApprovalService } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import { ElevationRepoLive } from "./ElevationRepo.live";
import { ElevationService } from "./ElevationService";
import { ADMIN_ACCESS_POLICY_SETTING_KEY } from "./policy";

/**
 * Runs the REAL, fully-wired stack (`ElevationRepoLive`, real
 * `ApprovalService`, real `EventBus`, all against the docker-compose
 * Postgres — see `../../services/ApprovalService.test.ts`'s identical
 * connection strategy) rather than `ElevationService.test.ts`'s in-memory
 * fakes, specifically to prove `notifyOwnerOfElevation`
 * lands a real `notifications` row — the one behavior that
 * can't be observed through a fake `ElevationRepo`. Every other behavior of
 * `ElevationService` is already covered by the fake-backed suite; this file
 * only re-covers the two paths that reach a grant.
 */
describe("ElevationService (live DB) — owner notification", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<ElevationService | ApprovalService>;

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    const DbTestLive = Layer.succeed(Db, db);
    // `provideMerge` (not `provide`) for `ApprovalService`: the
    // "with_approval" test below needs it in scope directly, to call
    // `decide` itself (there's no webhook wiring approval decisions to
    // `ElevationService.syncApproval` yet — see that method's doc comment).
    TestLayer = ElevationService.Default.pipe(
      Layer.provide(EventBus.Default),
      Layer.provideMerge(ApprovalService.Default),
      Layer.provide(ElevationRepoLive),
      Layer.provide(DbTestLive),
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, ElevationService | ApprovalService>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  /** A fresh org, an owner, an admin (distinct from the owner), and a machine the owner owns. */
  async function seedOrgOwnerAdminMachine() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("failed to insert org");

    const [owner, admin] = await db
      .insert(people)
      .values([
        { orgId: org.id, email: `owner-${crypto.randomUUID()}@example.com` },
        { orgId: org.id, email: `admin-${crypto.randomUUID()}@example.com` },
      ])
      .returning();
    if (!owner || !admin) throw new Error("failed to insert people");

    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        ownerPersonId: owner.id,
        name: "owned-machine",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-22.04",
      })
      .returning();
    if (!machine) throw new Error("failed to insert machine");

    return { org, owner, admin, machine };
  }

  const notificationsFor = (ownerPersonId: string) =>
    db.select().from(notifications).where(eq(notifications.ownerPersonId, ownerPersonId));

  test("org policy 'always': granting immediately persists one owner notification", async () => {
    const { org, owner, admin, machine } = await seedOrgOwnerAdminMachine();
    await db.insert(settingValues).values({
      scopeType: "org",
      scopeId: org.id,
      key: ADMIN_ACCESS_POLICY_SETTING_KEY,
      value: "always",
      source: "org",
    });

    const elevation = await run(
      Effect.gen(function* () {
        const svc = yield* ElevationService;
        return yield* svc.request({
          personId: admin.id,
          machineId: machine.id,
          level: "file_recovery",
          reason: "need it",
        });
      }),
    );
    expect(elevation.status).toBe("granted");

    const rows = await notificationsFor(owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.elevationId).toBe(elevation.id);
    expect(rows[0]?.orgId).toBe(org.id);
    expect(rows[0]?.readAt).toBeNull();
    expect(rows[0]?.message).toContain(admin.id);
  });

  test("org policy 'with_approval': the owner is notified only once the approval is actually granted", async () => {
    const { org, owner, admin, machine } = await seedOrgOwnerAdminMachine();
    // Default policy is already "with_approval" — no setting row needed.

    const requested = await run(
      Effect.gen(function* () {
        const svc = yield* ElevationService;
        return yield* svc.request({
          personId: admin.id,
          machineId: machine.id,
          level: "file_recovery",
          reason: "need it",
        });
      }),
    );
    expect(requested.status).toBe("requested");
    expect(await notificationsFor(owner.id)).toHaveLength(0);

    const approvalId = requested.approvalId;
    if (!approvalId) throw new Error("expected approvalId to be set");
    await run(
      Effect.gen(function* () {
        const approvalService = yield* ApprovalService;
        return yield* approvalService.decide(approvalId, org.id, owner.id, "approved");
      }),
    );

    const synced = await run(
      Effect.gen(function* () {
        const svc = yield* ElevationService;
        return yield* svc.syncApproval(requested.id, org.id);
      }),
    );
    expect(synced.status).toBe("granted");

    const rows = await notificationsFor(owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.elevationId).toBe(requested.id);
    expect(rows[0]?.orgId).toBe(org.id);
  });
});
