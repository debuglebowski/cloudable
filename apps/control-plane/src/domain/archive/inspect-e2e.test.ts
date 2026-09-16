import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
// The whole stack in one place: gate, session row, provider grant, ext4 reader.
//
// The fake provider is pointed at the real checked-in ext4 image, so this reads an
// actual filesystem through the actual session machinery. Nothing here is stubbed except
// the cloud: no invented directory listings, which would only prove the plumbing agrees
// with itself.
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
import { closeInspection, inspectionFilesystem, openInspection } from "./inspect";

const databaseUrl = config.databaseUrl;
const dbReachable = await isDbReachable(databaseUrl);

const DISK_EXTERNAL_ID = "fake-snap-data-e2e";

describe.skipIf(!dbReachable)("snapshot inspection — end to end (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<Db | EventBus | ProvisioningServiceTag>;

  beforeAll(() => {
    const image = join(mkdtempSync(join(tmpdir(), "cloudable-e2e-")), "home.img");
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
      makeFakeProvisioningServiceLive({
        snapshotImages: new Map([[DISK_EXTERNAL_ID, image]]),
      }),
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Db | EventBus | ProvisioningServiceTag>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  const seedOwnedSnapshot = async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    const [owner] = await db
      .insert(people)
      .values({ orgId: org.id, email: `p-${crypto.randomUUID()}@example.test` })
      .returning();
    if (!owner) throw new Error("seed failed");
    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        name: "m1",
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
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        capturedDisks: [{ kind: "data", externalId: DISK_EXTERNAL_ID, sizeBytes: 1024 }],
      })
      .returning();
    if (!snapshot) throw new Error("seed failed");
    return { org, owner, machine, snapshot };
  };

  test("open, list, read, close", async () => {
    const { org, owner, snapshot } = await seedOwnedSnapshot();

    const opened = await run(
      openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
    );
    const scope = { sessionId: opened.sessionId, orgId: org.id, personId: owner.id };

    const fs = await run(inspectionFilesystem(scope));
    const listing = await fs.list(opened.rootPath);
    if (!listing.ok || listing.op !== "list") throw new Error("expected a listing");
    expect(listing.entries.map((entry) => entry.name)).toContain("notes.txt");

    const read = await fs.read(`${opened.rootPath}/notes.txt`);
    if (!read.ok || read.op !== "read") throw new Error("expected a read");
    expect(Buffer.from(read.contentBase64, "base64").toString()).toContain("someone needs back");

    await run(
      closeInspection({
        sessionId: opened.sessionId,
        orgId: org.id,
        actor: { actorType: "person", actorId: owner.id },
        reason: "person_ended",
      }),
    );

    // After closing, the session is gone as far as every operation is concerned.
    const after = await Effect.runPromise(
      Effect.provide(Effect.flip(inspectionFilesystem(scope)), TestLayer),
    );
    expect((after as { _tag: string })._tag).toBe("InspectionSessionNotFoundError");
  });

  test("a snapshot naming a disk the provider no longer has refuses, with a reason", async () => {
    // A real production state, not a hypothetical: rows written before snapshots got
    // unique names point at objects that were later replaced or cleaned up. Before this
    // was handled, it surfaced as a 500, which tells whoever clicked nothing.
    const { org, owner, machine } = await seedOwnedSnapshot();
    const [orphaned] = await db
      .insert(snapshots)
      .values({
        orgId: org.id,
        machineId: machine.id,
        trigger: "archive",
        retentionDays: 30,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        // Never registered with the fake provider, so grantSnapshotRead answers not_found
        // exactly as Azure does for a deleted snapshot.
        capturedDisks: [{ kind: "data", externalId: "gone-from-the-provider", sizeBytes: 1024 }],
      })
      .returning();
    if (!orphaned) throw new Error("seed failed");

    const opened = await run(
      openInspection({ snapshotId: orphaned.id, orgId: org.id, personId: owner.id }),
    );

    const error = await Effect.runPromise(
      Effect.provide(
        Effect.flip(
          inspectionFilesystem({
            sessionId: opened.sessionId,
            orgId: org.id,
            personId: owner.id,
          }),
        ),
        TestLayer,
      ),
    );
    expect((error as { _tag: string })._tag).toBe("SnapshotDiskNotReadableError");
    expect((error as { reason: string }).reason).toContain("no longer exists at the provider");
  });

  test("another person cannot use a session they did not open", async () => {
    const { org, owner, snapshot } = await seedOwnedSnapshot();
    const [stranger] = await db
      .insert(people)
      .values({ orgId: org.id, email: `p-${crypto.randomUUID()}@example.test` })
      .returning();
    if (!stranger) throw new Error("seed failed");

    const opened = await run(
      openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
    );

    // Holding the session id is not standing. A session belongs to whoever opened it;
    // someone else's route in is their own elevation and their own session.
    const error = await Effect.runPromise(
      Effect.provide(
        Effect.flip(
          inspectionFilesystem({
            sessionId: opened.sessionId,
            orgId: org.id,
            personId: stranger.id,
          }),
        ),
        TestLayer,
      ),
    );
    expect((error as { _tag: string })._tag).toBe("InspectionSessionNotFoundError");
  });

  test("standing is re-checked on every operation, not just at open", async () => {
    // The property that makes a revoked elevation stop reads immediately rather than
    // within a minute, when the re-authorization sweep next runs.
    const { org, owner, machine, snapshot } = await seedOwnedSnapshot();

    const opened = await run(
      openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
    );
    const scope = { sessionId: opened.sessionId, orgId: org.id, personId: owner.id };
    await run(inspectionFilesystem(scope));

    // Take the machine away from them, exactly as offboarding would.
    await db.update(machines).set({ ownerPersonId: null }).where(eq(machines.id, machine.id));

    const error = await Effect.runPromise(
      Effect.provide(Effect.flip(inspectionFilesystem(scope)), TestLayer),
    );
    expect((error as { _tag: string })._tag).toBe("SnapshotInspectionDeniedError");
  });
});
