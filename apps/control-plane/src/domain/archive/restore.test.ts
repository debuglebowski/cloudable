import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import {
  events,
  integrations,
  machines,
  orgs,
  people,
  providerCatalogEntries,
  settingValues,
  snapshots,
} from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { ApprovalService, settingKeyFor } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import {
  type ProvisioningService,
  ProvisioningServiceTag,
} from "../../services/ProvisioningService";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { MachineService } from "../machine/MachineService";
import { restoreSnapshot } from "./restore";
import { createSnapshot } from "./snapshot";

/**
 * Regression coverage for the escalation-enforcement fix: `restoreSnapshot()` used to
 * compute the right approval floor per restore mode (`resolveRestoreApprovalFloor`) but
 * only ever wrote it into the approval's free-text `reason` — the actual gate was one
 * shared org-wide `approval_mode:snapshot_restore` setting applied identically to every
 * restore mode. An org that set that setting to `"none"` could therefore get a `"full"`
 * restore (secret bindings reattached) auto-approved with zero human review, directly
 * contradicting the intent that full restores be deliberately hardest to reach.
 *
 * Runs against the docker-compose Postgres, same convention as
 * `services/ApprovalService.test.ts` — this suite doesn't need an isolated database
 * (every test seeds its own fresh org/machine).
 */
describe("restoreSnapshot — approval escalation floor (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<
    Db | EventBus | ApprovalService | ProvisioningServiceTag | MachineService
  >;

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    TestLayer = Layer.mergeAll(
      dbLayer,
      Layer.provide(EventBus.Default, dbLayer),
      Layer.provide(ApprovalService.Default, dbLayer),
      // `createSnapshot` takes a real snapshot through this port now. These machines are
      // seeded straight into Postgres and never into the fake adapter's own map, so it
      // answers "not_found" — the one reason createSnapshot tolerates — and the rows land
      // with no captured disks, which is the truth for a machine with no infrastructure.
      FakeProvisioningServiceLive,
      // A restore that lands on a NEW machine goes through `MachineService.create`, so it
      // has to be real here rather than stubbed — the point of these tests is that the
      // restore reaches the machine, not that it reaches a double.
      MachineService.Default.pipe(Layer.provide(Layer.merge(dbLayer, FakeProvisioningServiceLive))),
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Db | EventBus | ApprovalService | ProvisioningServiceTag | MachineService
    >,
  ) => Effect.runPromise(Effect.provide(effect, TestLayer));

  /** Most tests restore onto the machine the snapshot came from, which is the ordinary
   * case. Archived, so it needs no `confirmDestroysData` — a machine whose disks are gone
   * has nothing left to destroy. */
  const onto = (machineId: string) => ({ kind: "existing_machine", machineId }) as const;

  /**
   * A snapshot that actually captured something.
   *
   * These machines are seeded straight into Postgres and never into the fake
   * provisioning adapter's own map, so its `snapshot()` answers "not_found" and
   * `createSnapshot` records a row with no captured disks — which `restoreSnapshot` now
   * refuses outright, as it should: restoring from a snapshot that names nothing is the
   * bug, not the test. These suites are about approval escalation and tenant isolation,
   * so they need a snapshot with something in it.
   */
  async function seedCapturedSnapshot(machineId: string) {
    const snapshot = await run(createSnapshot(machineId, "manual"));
    await db
      .update(snapshots)
      .set({
        capturedDisks: [{ kind: "data", externalId: `test-snap-${snapshot.id}`, sizeBytes: 1_024 }],
      })
      .where(eq(snapshots.id, snapshot.id));
    return snapshot;
  }

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  }

  async function seedMachine(
    orgId: string,
    state: "running" | "archived_restorable" = "archived_restorable",
  ) {
    const [machine] = await db
      .insert(machines)
      .values({
        orgId,
        name: "m1",
        // `azure` because a restore refuses any other provider: only azure captures
        // disks. The provisioning port itself is the fake, so nothing reaches a cloud.
        provider: "azure",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        state,
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  /**
   * What `MachineService.create` requires before it will build anything: the org must have
   * azure enabled, the size and region must be in the synced catalog, and the owner must
   * be a real person row (`machines.owner_person_id` has a live FK).
   *
   * Seeded rather than stubbed because a restore into a new machine goes through the whole
   * of `create` — its catalog validation included. A test that bypassed it would not be
   * exercising the path that runs in production.
   */
  async function seedCreatePrerequisites(orgId: string) {
    await db
      .insert(integrations)
      .values({ orgId, kind: "cloud", provider: "azure", identifier: "azure" });
    for (const [kind, code] of [
      ["region", "eastus"],
      ["sku", "Standard_B2s"],
    ] as const) {
      await db
        .insert(providerCatalogEntries)
        .values({ provider: "azure", kind, code, displayName: code, architecture: "x64" })
        .onConflictDoNothing();
    }
    const [person] = await db
      .insert(people)
      .values({ orgId, email: `person-${crypto.randomUUID()}@example.com`, role: "member" })
      .returning();
    if (!person) throw new Error("seed failed");
    return person;
  }

  /** Sets the ONE real gate — `ApprovalService`'s own `approval_mode:snapshot_restore`
   * setting — that every restore mode shares before this unit's escalation floor is
   * layered on top of it. */
  async function setRestoreApprovalMode(orgId: string, mode: "none" | "single" | "dual") {
    await db.insert(settingValues).values({
      scopeType: "org",
      scopeId: orgId,
      key: settingKeyFor("snapshot_restore"),
      value: mode,
      source: "org",
    });
  }

  const approvalStatusOf = (approvalId: string, orgId: string) =>
    run(
      Effect.gen(function* () {
        const approvalService = yield* ApprovalService;
        return yield* approvalService.status(approvalId, orgId);
      }),
    );

  test("the regression, re-anchored: an org's 'none' policy cannot auto-approve a restore that destroys a live machine's data", async () => {
    const org = await seedOrg();
    await setRestoreApprovalMode(org.id, "none");
    const source = await seedMachine(org.id);
    const snapshot = await seedCapturedSnapshot(source.id);
    const live = await seedMachine(org.id, "running");

    const result = await run(
      restoreSnapshot({
        snapshotId: snapshot.id,
        mode: "data",
        target: { kind: "existing_machine", machineId: live.id, confirmDestroysData: true },
        requestedByPersonId: crypto.randomUUID(),
        reason: "overwrite a running machine under a none-mode org policy",
      }),
    );

    // The original bug was `mode: "full"` auto-approving under a "none" org setting. That
    // mode is now refused outright, so the same shape is tested where it still bites: the
    // destructive target. An org cannot configure its way below two approvers for this.
    expect(result.approvalStatus).toBe("pending");
    expect(result.restored).toBe(false);

    const approval = await approvalStatusOf(result.approvalId, org.id);
    expect(approval.mode).toBe("dual");
    expect(approval.requiredApprovals).toBe(2);
    expect(approval.status).toBe("pending");
  });

  test("overwriting a machine that still has data is refused without an explicit acknowledgement", async () => {
    const org = await seedOrg();
    await setRestoreApprovalMode(org.id, "none");
    const source = await seedMachine(org.id);
    const snapshot = await seedCapturedSnapshot(source.id);
    const live = await seedMachine(org.id, "running");

    const result = await run(
      Effect.either(
        restoreSnapshot({
          snapshotId: snapshot.id,
          mode: "data",
          // No `confirmDestroysData` — the same request shape that is perfectly safe
          // against an archived machine.
          target: { kind: "existing_machine", machineId: live.id },
          requestedByPersonId: crypto.randomUUID(),
          reason: "overwrite a running machine without acknowledging it",
        }),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left._tag).toBe("RestoreTargetNotConfirmedError");

    // And it refused BEFORE requesting an approval — nobody is asked to sign off on a
    // request that then rejects itself.
    const approvals = await db.select().from(events).where(eq(events.orgId, org.id));
    expect(approvals.some((e) => e.type === "snapshot.restored")).toBe(false);
  });

  test("a snapshot does not claim to hold configuration it never captured", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id);
    const snapshot = await seedCapturedSnapshot(machine.id);

    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, snapshot.id));
    // Hardcoded `true` for this column's whole life, which is why every production
    // snapshot rendered as "data+config" in the console and the CLI. Nothing captures
    // configuration, and a `mode: "config"` restore refuses for exactly that reason — so
    // the product was asserting a snapshot held config AND that config could not be
    // restored from it.
    expect(row?.containsConfig).toBe(false);
  });

  test("modes with nothing behind them refuse, rather than writing a restore that did not happen", async () => {
    const org = await seedOrg();
    await setRestoreApprovalMode(org.id, "none");
    const machine = await seedMachine(org.id);
    const snapshot = await seedCapturedSnapshot(machine.id);

    for (const mode of ["config", "full"] as const) {
      const result = await run(
        Effect.either(
          restoreSnapshot({
            snapshotId: snapshot.id,
            mode,
            target: onto(machine.id),
            requestedByPersonId: crypto.randomUUID(),
            reason: `${mode} restore`,
            confirmSecretBindings: true,
          }),
        ),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left._tag).toBe("RestoreModeUnsupportedError");
    }

    // The whole point: both used to pass the approval gate and publish `snapshot.restored`
    // over a machine nothing had touched. No config is captured and no secret binding is
    // ever written, so neither could have done anything.
    const published = await db.select().from(events).where(eq(events.orgId, org.id));
    expect(published.some((e) => e.type === "snapshot.restored")).toBe(false);
  });

  test("mode 'data' onto an archived machine is NOT escalated: the org's own 'none' policy is honored unmodified, auto-approving", async () => {
    const org = await seedOrg();
    await setRestoreApprovalMode(org.id, "none");
    const machine = await seedMachine(org.id);
    const snapshot = await seedCapturedSnapshot(machine.id);

    const result = await run(
      restoreSnapshot({
        snapshotId: snapshot.id,
        mode: "data",
        target: onto(machine.id),
        requestedByPersonId: crypto.randomUUID(),
        reason: "data restore attempted under a none-mode org policy",
      }),
    );

    expect(result.approvalStatus).toBe("approved");
    expect(result.restored).toBe(true);

    // `restored: true` now means the provider was actually asked to put the disk back —
    // it used to mean only that an approval resolved. The machine leaves
    // `archived_restorable`, which nothing else in the system will ever do for it.
    const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
    expect(row?.state).toBe("provisioning");
    expect(row?.archivedAt).toBeNull();
  });

  test("the restore reaches the provider with the snapshot's own disk id, not some other snapshot's", async () => {
    const org = await seedOrg();
    await setRestoreApprovalMode(org.id, "none");
    const machine = await seedMachine(org.id);
    const snapshot = await seedCapturedSnapshot(machine.id);
    // A second snapshot of the same machine, so "it restored something" cannot pass for
    // "it restored the right thing".
    const decoy = await seedCapturedSnapshot(machine.id);
    expect(decoy.id).not.toBe(snapshot.id);

    const asked: string[] = [];
    const recordingService = {
      restoreDataDisk: ({
        machineId,
        dataDiskSnapshotId,
      }: { machineId: string; dataDiskSnapshotId: string }) => {
        asked.push(dataDiskSnapshotId);
        return Effect.succeed({ machineId, state: "provisioning" as const, externalId: "vm-1" });
      },
      create: () => Effect.die("not used in this test"),
      snapshot: () => Effect.die("not used in this test"),
      grantSnapshotRead: () => Effect.die("not used in this test"),
      revokeSnapshotRead: () => Effect.die("not used in this test"),
      snapshotDiskExists: () => Effect.die("not used in this test"),
      deleteSnapshotDisk: () => Effect.die("not used in this test"),
      archive: () => Effect.die("not used in this test"),
      reconcile: () => Effect.die("not used in this test"),
      reimage: () => Effect.die("not used in this test"),
      restart: () => Effect.die("not used in this test"),
    } as unknown as ProvisioningService;
    const recording = Layer.succeed(ProvisioningServiceTag, recordingService);

    const dbLayer = Layer.succeed(Db, db);
    await Effect.runPromise(
      Effect.provide(
        restoreSnapshot({
          snapshotId: snapshot.id,
          mode: "data",
          target: onto(machine.id),
          requestedByPersonId: crypto.randomUUID(),
          reason: "restore the right disk",
        }),
        Layer.mergeAll(
          dbLayer,
          Layer.provide(EventBus.Default, dbLayer),
          Layer.provide(ApprovalService.Default, dbLayer),
          recording,
          MachineService.Default.pipe(Layer.provide(Layer.merge(dbLayer, recording))),
        ),
      ),
    );

    expect(asked).toEqual([`test-snap-${snapshot.id}`]);
  });

  test("a restore into a NEW machine creates one and never touches the machine it came from", async () => {
    const org = await seedOrg();
    await setRestoreApprovalMode(org.id, "none");
    const source = await seedMachine(org.id);
    const snapshot = await seedCapturedSnapshot(source.id);
    const owner = (await seedCreatePrerequisites(org.id)).id;

    const result = await run(
      restoreSnapshot({
        snapshotId: snapshot.id,
        mode: "data",
        target: { kind: "new_machine", ownerPersonId: owner, name: "restored-one" },
        requestedByPersonId: crypto.randomUUID(),
        reason: "restore into a new machine",
      }),
    );

    expect(result.restored).toBe(true);
    expect(result.targetMachineId).not.toBe(source.id);

    const [created] = await db
      .select()
      .from(machines)
      .where(eq(machines.id, result.targetMachineId as string));
    expect(created?.ownerPersonId).toBe(owner);
    expect(created?.name).toBe("restored-one");
    // Shape is inherited from the machine the snapshot came from — the person is asking
    // for that machine back, not for a chance to re-pick its size.
    expect(created?.sizeSku).toBe(source.sizeSku);
    expect(created?.image).toBe(source.image);

    // The source is untouched. This is what makes restoring a LIVE machine safe.
    const [untouched] = await db.select().from(machines).where(eq(machines.id, source.id));
    expect(untouched?.state).toBe("archived_restorable");
  });
});
