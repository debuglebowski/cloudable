import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// The access gate for snapshot inspection, against real Postgres.
//
// These are the tests that matter most in this feature. Everything else is plumbing:
// this decides who can read a departed colleague's home directory.
import * as schema from "@cloudable/schema";
import { elevations, machines, orgs, people, settingValues, snapshots } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import type { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { FakeProvisioningServiceLive } from "../../services/ProvisioningService.fake";
import { isDbReachable } from "../../testing/db-reachable";
import { ACCESS_METHODS_ENABLED_KEY } from "../machine/settings";
import { closeInspection, openInspection } from "./inspect";
import { isAuthorizedToInspectSnapshot } from "./inspect-authorization";

const databaseUrl = config.databaseUrl;
const dbReachable = await isDbReachable(databaseUrl);

describe.skipIf(!dbReachable)("snapshot inspection — the gate (requires Postgres)", () => {
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
      FakeProvisioningServiceLive,
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Db | EventBus | ProvisioningServiceTag>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  const runFail = <A, E>(effect: Effect.Effect<A, E, Db | EventBus | ProvisioningServiceTag>) =>
    Effect.runPromise(Effect.provide(Effect.flip(effect), TestLayer));

  const seedOrg = async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  };

  const seedPerson = async (orgId: string) => {
    const [person] = await db
      .insert(people)
      .values({ orgId, email: `p-${crypto.randomUUID()}@example.test` })
      .returning();
    if (!person) throw new Error("seed failed");
    return person;
  };

  const seedMachine = async (orgId: string, ownerPersonId: string | null) => {
    const [machine] = await db
      .insert(machines)
      .values({
        orgId,
        name: "m1",
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        ownerPersonId,
        state: "archived_restorable",
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  };

  /** A snapshot with a captured persistent disk — the normal case. */
  const seedSnapshot = async (
    orgId: string,
    machineId: string,
    overrides: Partial<typeof snapshots.$inferInsert> = {},
  ) => {
    const [snapshot] = await db
      .insert(snapshots)
      .values({
        orgId,
        machineId,
        trigger: "archive",
        retentionDays: 30,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        capturedDisks: [
          { kind: "data", externalId: `snap-${crypto.randomUUID()}`, sizeBytes: 1024 },
        ],
        ...overrides,
      })
      .returning();
    if (!snapshot) throw new Error("seed failed");
    return snapshot;
  };

  const grantElevation = (
    orgId: string,
    personId: string,
    machineId: string,
    level: "file_recovery" | "shell",
    expiresAt = new Date(Date.now() + 3_600_000),
  ) =>
    db.insert(elevations).values({
      orgId,
      personId,
      machineId,
      level,
      reason: "recovering a file",
      status: "granted",
      grantedAt: new Date(),
      expiresAt,
    });

  describe("who may look", () => {
    test("the machine's owner may inspect their own snapshot", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);

      const opened = await run(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
      );
      expect(opened.snapshotId).toBe(snapshot.id);
      expect(opened.rootPath).toBe("/home/cloudable");
    });

    test("a non-owner with no elevation may not", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const stranger = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);

      const error = await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: stranger.id }),
      );
      expect((error as { _tag: string })._tag).toBe("SnapshotInspectionDeniedError");
    });

    test("AN OFFBOARDED MACHINE'S SNAPSHOT IS NOT OPEN TO THE ORG", async () => {
      // The whole reason this gate is its own function. Offboarding clears the owner and
      // then archives, so `ownerPersonId` is null on every snapshot it produces. The
      // live-access gate answers `true` for a null owner — correct there, a hole here.
      const org = await seedOrg();
      const stranger = await seedPerson(org.id);
      const machine = await seedMachine(org.id, null);
      const snapshot = await seedSnapshot(org.id, machine.id);

      const error = await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: stranger.id }),
      );
      expect((error as { _tag: string })._tag).toBe("SnapshotInspectionDeniedError");
      // And it says what to do about it, rather than just refusing.
      expect((error as { reason: string }).reason).toContain("offboarded");
    });

    test("the live-access gate would have allowed exactly that, which is why this one exists", async () => {
      // Pinned deliberately. If someone ever "simplifies" the two gates into one, this
      // fails and says why rather than quietly reopening the hole.
      const { isAuthorizedForInteractiveAccess } = await import(
        "../../tunnel/access-authorization"
      );
      const org = await seedOrg();
      const stranger = await seedPerson(org.id);
      const machine = await seedMachine(org.id, null);

      const live = await Effect.runPromise(
        isAuthorizedForInteractiveAccess(db, {
          personId: stranger.id,
          machineId: machine.id,
          ownerPersonId: null,
          method: "files",
        }),
      );
      const inspect = await Effect.runPromise(
        isAuthorizedToInspectSnapshot(db, {
          personId: stranger.id,
          machineId: machine.id,
          ownerPersonId: null,
        }),
      );

      expect(live).toBe(true);
      expect(inspect).toBe(false);
    });

    test("a granted file_recovery elevation is enough", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const admin = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);
      await grantElevation(org.id, admin.id, machine.id, "file_recovery");

      const opened = await run(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: admin.id }),
      );
      expect(opened.sessionId).toBeTruthy();
    });

    test("a shell elevation also works — it dominates file recovery", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const admin = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);
      await grantElevation(org.id, admin.id, machine.id, "shell");

      const opened = await run(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: admin.id }),
      );
      expect(opened.sessionId).toBeTruthy();
    });

    test("an EXPIRED elevation is not enough", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const admin = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);
      await grantElevation(
        org.id,
        admin.id,
        machine.id,
        "file_recovery",
        new Date(Date.now() - 1000),
      );

      const error = await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: admin.id }),
      );
      expect((error as { _tag: string })._tag).toBe("SnapshotInspectionDeniedError");
    });

    test("an elevation still awaiting approval is not enough", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const admin = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);
      await db.insert(elevations).values({
        orgId: org.id,
        personId: admin.id,
        machineId: machine.id,
        level: "file_recovery",
        reason: "pending",
        status: "requested",
      });

      const error = await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: admin.id }),
      );
      expect((error as { _tag: string })._tag).toBe("SnapshotInspectionDeniedError");
    });

    test("an elevation on a DIFFERENT machine is not enough", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const admin = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const other = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);
      await grantElevation(org.id, admin.id, other.id, "shell");

      const error = await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: admin.id }),
      );
      expect((error as { _tag: string })._tag).toBe("SnapshotInspectionDeniedError");
    });
  });

  describe("what may be looked at", () => {
    test("another org's snapshot is not-found, never denied", async () => {
      // Never "denied": that would confirm the id is real to someone in another tenant.
      const org = await seedOrg();
      const other = await seedOrg();
      const person = await seedPerson(other.id);
      const machine = await seedMachine(org.id, null);
      const snapshot = await seedSnapshot(org.id, machine.id);

      const error = await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: other.id, personId: person.id }),
      );
      expect((error as { _tag: string })._tag).toBe("SnapshotNotFoundError");
    });

    test("a snapshot that captured nothing has nothing to read", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id, { capturedDisks: [] });

      const error = await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
      );
      expect((error as { _tag: string })._tag).toBe("SnapshotEmptyError");
    });

    test("an expired snapshot refuses, with the reason shown", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id, { expiredAt: new Date() });

      const error = await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
      );
      expect((error as { _tag: string })._tag).toBe("SnapshotExpiredError");
      expect((error as { reason: string }).reason).toContain("retention window");
    });

    test("an OS-disk-only snapshot has no readable volume in v1", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id, {
        capturedDisks: [{ kind: "os", externalId: "snap-os", sizeBytes: 1024 }],
      });

      const error = await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
      );
      expect((error as { _tag: string })._tag).toBe("SnapshotDiskNotReadableError");
    });

    test("the org can turn inspection off, and then even the owner cannot look", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);
      await db.insert(settingValues).values({
        scopeType: "org",
        scopeId: org.id,
        key: ACCESS_METHODS_ENABLED_KEY,
        value: { webTerminal: true, ssh: true, files: true, snapshotInspect: false },
        source: "org",
      });

      const error = await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
      );
      expect((error as { reason: string }).reason).toContain("turned off");
    });
  });

  describe("the record", () => {
    test("opening writes access.session_started and a session row", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);

      const opened = await run(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
      );

      const [row] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, opened.sessionId));
      expect(row?.method).toBe("snapshot_files");
      expect(row?.snapshotId).toBe(snapshot.id);
      // No token is minted: nothing downstream verifies one.
      expect(row?.sessionToken).toBeNull();

      const started = await db
        .select()
        .from(schema.events)
        .where(eq(schema.events.correlationId, opened.sessionId));
      expect(started.map((event) => event.type)).toContain("access.session_started");
    });

    test("a refusal is evidence too", async () => {
      const org = await seedOrg();
      const stranger = await seedPerson(org.id);
      const machine = await seedMachine(org.id, null);
      const snapshot = await seedSnapshot(org.id, machine.id);

      await runFail(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: stranger.id }),
      );

      const denied = await db
        .select()
        .from(schema.events)
        .where(eq(schema.events.correlationId, snapshot.id));
      expect(denied.map((event) => event.type)).toContain("access.session_denied");
    });

    test("closing ends the row and writes access.session_ended", async () => {
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);

      const opened = await run(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
      );
      await run(
        closeInspection({
          sessionId: opened.sessionId,
          orgId: org.id,
          actor: { actorType: "person", actorId: owner.id },
          reason: "person_ended",
        }),
      );

      const [row] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, opened.sessionId));
      expect(row?.endedAt).not.toBeNull();
      expect(row?.terminationReason).toBe("person_ended");

      const types = (
        await db
          .select()
          .from(schema.events)
          .where(eq(schema.events.correlationId, opened.sessionId))
      ).map((event) => event.type);
      expect(types).toContain("access.session_ended");
    });

    test("closing twice is not an error", async () => {
      // Several paths end a session — the person, the sweep, a policy change, the
      // daemon. Any of them may be second.
      const org = await seedOrg();
      const owner = await seedPerson(org.id);
      const machine = await seedMachine(org.id, owner.id);
      const snapshot = await seedSnapshot(org.id, machine.id);

      const opened = await run(
        openInspection({ snapshotId: snapshot.id, orgId: org.id, personId: owner.id }),
      );
      const close = () =>
        run(
          closeInspection({
            sessionId: opened.sessionId,
            orgId: org.id,
            actor: { actorType: "system", actorId: "test" },
            reason: "policy_terminated",
          }),
        );
      await close();
      await close();
    });
  });
});
