import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import {
  events,
  machinePackageActions,
  machinePackages,
  machines,
  orgs,
  settingValues,
} from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { ApprovalService, settingKeyFor } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { listOrgPackages } from "../organisation/packages";
import { MachineService } from "./MachineService";
import {
  applyApprovedEnsureEdit,
  requestMachineManifestEdit,
  requestOrgManifestEdit,
} from "./package-ensure";
import { requestPackageAction } from "./package-request";

// Runs against the docker-compose Postgres, like `domain/organisation/packages.test.ts`:
// every test scopes its rows by a fresh random org.
describe("ensure settings", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  type Env = MachineService | Db | EventBus | ApprovalService;
  let TestLayer: Layer.Layer<Env>;

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    const eventBusLayer = EventBus.Default.pipe(Layer.provide(dbLayer));
    TestLayer = Layer.mergeAll(
      eventBusLayer,
      MachineService.Default.pipe(Layer.provide(FakeProvisioningServiceLive)),
      ApprovalService.Default,
      dbLayer,
    ).pipe(Layer.provide(dbLayer));
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Env>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  const runFail = <A, E>(effect: Effect.Effect<A, E, Env>) =>
    Effect.runPromise(Effect.provide(Effect.flip(effect), TestLayer));

  const requester = crypto.randomUUID();
  const approver = crypto.randomUUID();

  async function seedOrg(ensureMode?: "none" | "single") {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    if (ensureMode) {
      await db.insert(settingValues).values({
        scopeType: "org",
        scopeId: org.id,
        key: settingKeyFor("package_ensure"),
        value: ensureMode,
        source: "org",
      });
    }
    return org;
  }

  async function seedMachine(orgId: string, installedPackages: string[] = []) {
    const [machine] = await db
      .insert(machines)
      .values({
        orgId,
        name: "m1",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        installedPackages,
        baselinePackages: [],
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  const orgSetting = async (orgId: string, packageName: string) =>
    (
      await db
        .select({ setting: machinePackages.setting })
        .from(machinePackages)
        .where(
          and(
            eq(machinePackages.scopeType, "org"),
            eq(machinePackages.scopeId, orgId),
            eq(machinePackages.packageName, packageName),
          ),
        )
    )[0]?.setting;

  test("setting a package to Ensure waits for approval; the rest of the edit applies at once", async () => {
    const org = await seedOrg();
    const result = await run(
      requestOrgManifestEdit({
        orgId: org.id,
        personId: requester,
        upserts: [
          { packageName: "ripgrep", setting: "ensure_installed" },
          { packageName: "jq", description: "JSON on the command line" },
        ],
      }),
    );
    expect(result.ensureApprovals?.map((a) => [a.packageName, a.status])).toEqual([
      ["ripgrep", "pending"],
    ]);
    expect(result.items.map((entry) => entry.packageName)).toEqual(["jq"]);
    expect(await orgSetting(org.id, "ripgrep")).toBeUndefined();

    // Granting it writes the setting, attributed to the person who asked.
    const approvalId = result.ensureApprovals?.[0]?.approvalId ?? "";
    await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const decided = yield* approvals.decide(approvalId, org.id, approver, "approved", "ok");
        expect(decided.status).toBe("approved");
        // What `carryOutApproved` runs for this type.
        yield* applyApprovedEnsureEdit(decided);
      }),
    );
    expect(await orgSetting(org.id, "ripgrep")).toBe("ensure_installed");
    const changed = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, org.id), eq(events.type, "org.setting_changed")));
    expect(changed.some((event) => event.actorId === requester)).toBe(true);
  });

  test("with the org's package_ensure mode at none, the setting is written straight away", async () => {
    const org = await seedOrg("none");
    const result = await run(
      requestOrgManifestEdit({
        orgId: org.id,
        personId: requester,
        upserts: [{ packageName: "ripgrep", setting: "ensure_latest" }],
      }),
    );
    expect(result.ensureApprovals?.[0]?.status).toBe("approved");
    expect(await orgSetting(org.id, "ripgrep")).toBe("ensure_latest");
  });

  test("moving between the two Ensure settings needs approval too; back to Allowed does not", async () => {
    const org = await seedOrg("none");
    await run(
      requestOrgManifestEdit({
        orgId: org.id,
        personId: requester,
        upserts: [{ packageName: "ripgrep", setting: "ensure_installed" }],
      }),
    );
    await db
      .update(settingValues)
      .set({ value: "single" })
      .where(
        and(
          eq(settingValues.scopeId, org.id),
          eq(settingValues.key, settingKeyFor("package_ensure")),
        ),
      );

    const toLatest = await run(
      requestOrgManifestEdit({
        orgId: org.id,
        personId: requester,
        upserts: [{ packageName: "ripgrep", setting: "ensure_latest" }],
      }),
    );
    expect(toLatest.ensureApprovals?.[0]?.status).toBe("pending");
    expect(await orgSetting(org.id, "ripgrep")).toBe("ensure_installed");

    const toAllowed = await run(
      requestOrgManifestEdit({
        orgId: org.id,
        personId: requester,
        upserts: [{ packageName: "ripgrep", setting: "allowed" }],
      }),
    );
    expect(toAllowed.ensureApprovals).toBeUndefined();
    expect(await orgSetting(org.id, "ripgrep")).toBe("allowed");
  });

  test("refuses Ensure for a package Cloudable cannot install, and Ensure latest with a pin", async () => {
    const org = await seedOrg();
    const notInstallable = await runFail(
      requestOrgManifestEdit({
        orgId: org.id,
        personId: requester,
        upserts: [{ packageName: "home:chromium", setting: "ensure_installed" }],
      }),
    );
    expect(notInstallable._tag).toBe("PackageEnsureSettingError");

    const latestWithPin = await runFail(
      requestOrgManifestEdit({
        orgId: org.id,
        personId: requester,
        upserts: [{ packageName: "nodejs", versionPin: "20", setting: "ensure_latest" }],
      }),
    );
    expect(latestWithPin._tag).toBe("PackageEnsureSettingError");
    expect(await run(listOrgPackages(org.id))).toEqual([]);
  });

  test("a machine-level Ensure edit waits for approval too", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id);
    const result = await run(
      requestMachineManifestEdit({
        machineId: machine.id,
        orgId: org.id,
        personId: requester,
        upserts: [{ packageName: "ripgrep", setting: "ensure_installed" }],
      }),
    );
    expect(result.ensureApprovals?.[0]?.status).toBe("pending");
    expect(result.manifest).toEqual([]);
  });

  test("a report queues an install for a missing Ensure package, recorded as system with the setting", async () => {
    const org = await seedOrg("none");
    const machine = await seedMachine(org.id, ["curl"]);
    await run(
      requestOrgManifestEdit({
        orgId: org.id,
        personId: requester,
        upserts: [
          { packageName: "ripgrep", setting: "ensure_installed" },
          { packageName: "curl", setting: "ensure_installed" },
          { packageName: "jq" },
        ],
      }),
    );

    const queued = await run(
      Effect.flatMap(MachineService, (service) =>
        service.ensurePackages({ machineId: machine.id, orgId: org.id, now: new Date() }),
      ),
    );
    expect(queued).toEqual(["ripgrep"]);

    const actions = await db
      .select()
      .from(machinePackageActions)
      .where(eq(machinePackageActions.machineId, machine.id));
    expect(actions.map((a) => [a.packageName, a.op, a.trigger, a.requestedByPersonId])).toEqual([
      ["ripgrep", "install", "ensure_installed", null],
    ]);

    const requested = await db
      .select()
      .from(events)
      .where(
        and(eq(events.machineId, machine.id), eq(events.type, "machine.package_action_requested")),
      );
    expect(
      requested.map((event) => [event.actorType, (event.payload as { trigger?: string }).trigger]),
    ).toEqual([["system", "ensure_installed"]]);

    // Outstanding: the next report queues nothing more.
    const again = await run(
      Effect.flatMap(MachineService, (service) =>
        service.ensurePackages({ machineId: machine.id, orgId: org.id, now: new Date() }),
      ),
    );
    expect(again).toEqual([]);
  });

  test("a failed ensure install shows in the packages table with its next try", async () => {
    const org = await seedOrg("none");
    const machine = await seedMachine(org.id);
    await run(
      requestOrgManifestEdit({
        orgId: org.id,
        personId: requester,
        upserts: [{ packageName: "ripgrep", setting: "ensure_installed" }],
      }),
    );
    const failedAt = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(machinePackageActions).values({
      machineId: machine.id,
      packageName: "ripgrep",
      op: "install",
      status: "failed",
      requestedByPersonId: null,
      trigger: "ensure_installed",
      correlationId: "c",
      startedAt: failedAt,
      finishedAt: failedAt,
      failureReason: "E: Unable to locate package ripgrep",
    });

    const queued = await run(
      Effect.flatMap(MachineService, (service) =>
        service.ensurePackages({ machineId: machine.id, orgId: org.id, now: new Date() }),
      ),
    );
    expect(queued).toEqual([]);

    const view = await run(
      Effect.flatMap(MachineService, (service) => service.packagesView(machine.id, org.id)),
    );
    const row = view.items.find((item) => item.packageName === "ripgrep");
    expect(row?.setting).toBe("ensure_installed");
    expect(row?.ensureFailure?.reason).toBe("E: Unable to locate package ripgrep");
    expect(new Date(row?.ensureFailure?.nextAttemptAt ?? 0).getTime()).toBe(
      failedAt.getTime() + 24 * 60 * 60 * 1000,
    );
  });

  test("uninstalling a package set to Ensure is refused", async () => {
    const org = await seedOrg("none");
    const machine = await seedMachine(org.id, ["ripgrep"]);
    await run(
      requestOrgManifestEdit({
        orgId: org.id,
        personId: requester,
        upserts: [{ packageName: "ripgrep", setting: "ensure_installed" }],
      }),
    );
    const refused = await runFail(
      requestPackageAction({
        machineId: machine.id,
        orgId: org.id,
        personId: requester,
        packageName: "ripgrep",
        op: "uninstall",
        reason: undefined,
      }),
    );
    expect(refused.error.code).toBe("ensured_package");
  });
});
