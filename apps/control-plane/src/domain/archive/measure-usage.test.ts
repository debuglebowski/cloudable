import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
// `snapshots.usedBytes` read off the copied filesystem when no agent reported one.
//
// Its own file because it needs a provider that serves a real image for ANY disk id:
// the id the adapter mints contains the snapshot id, which is generated inside
// `createSnapshot` and cannot be registered in advance.
import * as schema from "@cloudable/schema";
import { machines, orgs, people } from "@cloudable/schema";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { makeFakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { isDbReachable } from "../../testing/db-reachable";
import { createSnapshot } from "./snapshot";

const databaseUrl = config.databaseUrl;
const dbReachable = await isDbReachable(databaseUrl);

/** The checked-in fixture: a 96 MiB ext4 holding a handful of files. */
const FIXTURE_TOTAL_BYTES = 96 * 1024 * 1024;

describe.skipIf(!dbReachable)("snapshot used-size measurement (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<Db | EventBus | ProvisioningServiceTag>;

  beforeAll(() => {
    const image = join(mkdtempSync(join(tmpdir(), "cloudable-measure-")), "home.img");
    writeFileSync(
      image,
      gunzipSync(
        readFileSync(
          new URL("../../snapshot-fs/__fixtures__/home.img.gz", import.meta.url).pathname,
        ),
      ),
    );

    sql = postgres(databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    TestLayer = Layer.mergeAll(
      dbLayer,
      Layer.provide(EventBus.Default, dbLayer),
      makeFakeProvisioningServiceLive({ fallbackSnapshotImage: image }),
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Db | EventBus | ProvisioningServiceTag>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  /** Seeds a machine both in Postgres and in the fake adapter, so its `snapshot()`
   * actually copies a disk instead of answering not_found. */
  const seedMachine = async (volumeUsage: unknown) => {
    const [org] = await db
      .insert(orgs)
      .values({ name: `measure-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    const [owner] = await db
      .insert(people)
      .values({ orgId: org.id, email: `me-${crypto.randomUUID()}@example.test` })
      .returning();
    if (!owner) throw new Error("seed failed");
    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        name: "measured",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        ownerPersonId: owner.id,
        state: "running",
        volumeUsage: volumeUsage as never,
      })
      .returning();
    if (!machine) throw new Error("seed failed");

    return { machine, orgId: org.id };
  };

  /**
   * Registers the machine with the fake adapter and snapshots it IN ONE EFFECT.
   *
   * Both halves must share a provider instance: `Effect.provide` builds the layer per
   * call, so a `create()` in one `run()` and a `createSnapshot()` in another see two
   * different fakes with two different machine maps — the second answers not_found and
   * copies nothing.
   */
  const createAndSnapshot = (machineId: string, orgId: string, scope: "full" | "shallow") =>
    run(
      Effect.gen(function* () {
        const provisioning = yield* ProvisioningServiceTag;
        yield* provisioning.create({
          machineId,
          orgId,
          provider: "fake",
          region: null,
          sizeSku: "Standard_B2s",
          image: "ubuntu-24.04",
        });
        return yield* createSnapshot(machineId, "manual", undefined, undefined, { scope });
      }),
    );

  test("reads the size off the disk when the agent never reported one", async () => {
    // The case this exists for. Before it, these rows landed with usedBytes null and the
    // console fell back to the PROVISIONED size — "64.0 GiB max" for a disk holding
    // 1.56 GiB. A ceiling in the place a person reads a size.
    const { machine, orgId } = await seedMachine(null);
    const created = await createAndSnapshot(machine.id, orgId, "shallow");

    expect(created.capturedDisks).toHaveLength(1);
    expect(created.usedBytes).not.toBeNull();
    expect(created.usedBytes ?? 0).toBeGreaterThan(0);
    // A real measurement, well under the filesystem's own total.
    expect(created.usedBytes ?? 0).toBeLessThan(FIXTURE_TOTAL_BYTES);
  });

  test("the agent's own figure still wins when it has one", async () => {
    // It saw the live machine and covers every disk in scope; reading the copy only ever
    // covers the persistent one.
    const { machine, orgId } = await seedMachine({ persistent: { usedBytes: 4_242 } });
    const created = await createAndSnapshot(machine.id, orgId, "shallow");
    expect(created.usedBytes).toBe(4_242);
  });

  test("a full snapshot is not measured from the disk", async () => {
    // Only the persistent disk is readable, so a full snapshot's total would understate
    // by whatever the OS disk holds. Better null than confidently wrong.
    const { machine, orgId } = await seedMachine(null);
    const created = await createAndSnapshot(machine.id, orgId, "full");
    // Both disks captured, so there is more than the readable one.
    expect(created.capturedDisks).toHaveLength(2);
    expect(created.usedBytes).toBeNull();
  });
});
