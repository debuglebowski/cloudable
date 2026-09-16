import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { machinePackageActions, machines, orgs, people } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import {
  ACTION_EXPIRY_MS,
  applyActionResults,
  collectPendingActions,
  enqueuePackageAction,
  expireStaleActions,
  outstandingActionsByPackage,
} from "./package-actions";

// Shared docker-compose Postgres, every test scoped to a fresh random org —
// same convention as the other DB-backed tests in this directory.
describe("package actions", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seed() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    const [person] = await db
      .insert(people)
      .values({ orgId: org.id, email: `p-${crypto.randomUUID()}@test.local` })
      .returning();
    const [machine] = await db
      .insert(machines)
      .values({
        orgId: org.id,
        name: `m-${crypto.randomUUID()}`,
        provider: "fake",
        region: "eastus",
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
      })
      .returning();
    if (!person || !machine) throw new Error("seed failed");
    return { org, person, machine };
  }

  const enqueue = (
    machineId: string,
    orgId: string,
    personId: string,
    overrides: Partial<Parameters<typeof enqueuePackageAction>[1]> = {},
  ) =>
    Effect.runPromise(
      enqueuePackageAction(db, {
        machineId,
        orgId,
        packageName: "ripgrep",
        op: "install",
        versionPin: null,
        requestedByPersonId: personId,
        correlationId: crypto.randomUUID(),
        isBaselinePackage: false,
        ...overrides,
      }),
    );

  test("enqueuing bumps the machine's desired-state version in the same breath", async () => {
    const { org, person, machine } = await seed();
    const [before] = await db
      .select({ v: machines.desiredStateVersion })
      .from(machines)
      .where(eq(machines.id, machine.id));

    await enqueue(machine.id, org.id, person.id);

    const [after] = await db
      .select({ v: machines.desiredStateVersion })
      .from(machines)
      .where(eq(machines.id, machine.id));
    // An action the agent can never be told about is worse than no action:
    // without the bump, the next poll is a 304 and the work sits forever.
    expect(after?.v).toBe((before?.v ?? 0) + 1);
  });

  test("a poll collects a pending action exactly once", async () => {
    const { org, person, machine } = await seed();
    await enqueue(machine.id, org.id, person.id);

    const first = await Effect.runPromise(collectPendingActions(db, machine.id, new Date()));
    const second = await Effect.runPromise(collectPendingActions(db, machine.id, new Date()));

    // Two polls racing — an agent retrying, or two control-plane replicas —
    // must not hand the same install to the machine twice.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(first[0]?.status).toBe("running");
  });

  test("a second request for the same package is refused while one is outstanding", async () => {
    const { org, person, machine } = await seed();
    await enqueue(machine.id, org.id, person.id);

    const error = await Effect.runPromise(
      Effect.flip(
        enqueuePackageAction(db, {
          machineId: machine.id,
          orgId: org.id,
          packageName: "ripgrep",
          op: "install",
          versionPin: null,
          requestedByPersonId: person.id,
          correlationId: crypto.randomUUID(),
          isBaselinePackage: false,
        }),
      ),
    );

    expect(error.reason).toBe("already_pending");
  });

  test("a base image package is refused outright", async () => {
    const { org, person, machine } = await seed();

    const error = await Effect.runPromise(
      Effect.flip(
        enqueuePackageAction(db, {
          machineId: machine.id,
          orgId: org.id,
          packageName: "systemd",
          op: "uninstall",
          versionPin: null,
          requestedByPersonId: person.id,
          correlationId: crypto.randomUUID(),
          isBaselinePackage: true,
        }),
      ),
    );

    // A button that removes systemd, with no undo, is not a capability worth
    // having.
    expect(error.reason).toBe("baseline_package");
  });

  test.each(["ripgrep; rm -rf /", "$(whoami)", "../../etc/passwd", "-oRoot=/", "rip grep"])(
    "refuses to record %s",
    async (packageName) => {
      const { org, person, machine } = await seed();

      const error = await Effect.runPromise(
        Effect.flip(
          enqueuePackageAction(db, {
            machineId: machine.id,
            orgId: org.id,
            packageName,
            op: "install",
            versionPin: null,
            requestedByPersonId: person.id,
            correlationId: crypto.randomUUID(),
            isBaselinePackage: false,
          }),
        ),
      );

      expect(error.reason).toBe("invalid_package_name");
      const rows = await db
        .select()
        .from(machinePackageActions)
        .where(eq(machinePackageActions.machineId, machine.id));
      expect(rows).toEqual([]);
    },
  );

  test("an outcome closes the action it names, and only while it is running", async () => {
    const { org, person, machine } = await seed();
    const queued = await enqueue(machine.id, org.id, person.id);

    // Not collected yet, so there is nothing an agent could honestly report on.
    const tooEarly = await Effect.runPromise(
      applyActionResults(db, machine.id, [{ id: queued.id, outcome: "succeeded" }], new Date()),
    );
    expect(tooEarly).toHaveLength(0);

    await Effect.runPromise(collectPendingActions(db, machine.id, new Date()));
    const closed = await Effect.runPromise(
      applyActionResults(
        db,
        machine.id,
        [{ id: queued.id, outcome: "failed", detail: "E: Unable to locate package" }],
        new Date(),
      ),
    );

    expect(closed[0]?.status).toBe("failed");
    expect(closed[0]?.failureReason).toBe("E: Unable to locate package");

    // And it cannot be closed twice.
    const again = await Effect.runPromise(
      applyActionResults(db, machine.id, [{ id: queued.id, outcome: "succeeded" }], new Date()),
    );
    expect(again).toHaveLength(0);
  });

  test("one machine cannot report on another machine's work", async () => {
    const a = await seed();
    const b = await seed();
    const queued = await enqueue(a.machine.id, a.org.id, a.person.id);
    await Effect.runPromise(collectPendingActions(db, a.machine.id, new Date()));

    const stolen = await Effect.runPromise(
      applyActionResults(db, b.machine.id, [{ id: queued.id, outcome: "succeeded" }], new Date()),
    );

    expect(stolen).toHaveLength(0);
    const [row] = await db
      .select()
      .from(machinePackageActions)
      .where(eq(machinePackageActions.id, queued.id));
    expect(row?.status).toBe("running");
  });

  test("an action collected and never reported expires, but only once it is old enough", async () => {
    const { org, person, machine } = await seed();
    await enqueue(machine.id, org.id, person.id);
    const collectedAt = new Date();
    await Effect.runPromise(collectPendingActions(db, machine.id, collectedAt));

    const tooSoon = await Effect.runPromise(
      expireStaleActions(db, machine.id, new Date(collectedAt.getTime() + ACTION_EXPIRY_MS - 1000)),
    );
    expect(tooSoon).toHaveLength(0);

    const expired = await Effect.runPromise(
      expireStaleActions(db, machine.id, new Date(collectedAt.getTime() + ACTION_EXPIRY_MS + 1000)),
    );
    expect(expired).toHaveLength(1);
    expect(expired[0]?.status).toBe("expired");
  });

  test("the expiry clock runs from collection, not from the request", async () => {
    const { org, person, machine } = await seed();
    await enqueue(machine.id, org.id, person.id);

    // Never collected — a machine that is asleep or polling slowly has not
    // failed at anything, however long ago the request was made.
    const expired = await Effect.runPromise(
      expireStaleActions(db, machine.id, new Date(Date.now() + ACTION_EXPIRY_MS * 10)),
    );

    expect(expired).toHaveLength(0);
  });

  test("outstanding actions are keyed by package for the table", async () => {
    const { org, person, machine } = await seed();
    await enqueue(machine.id, org.id, person.id, { packageName: "ripgrep" });
    await enqueue(machine.id, org.id, person.id, { packageName: "jq", op: "uninstall" });

    const byPackage = await Effect.runPromise(outstandingActionsByPackage(db, machine.id));

    expect([...byPackage.keys()].sort()).toEqual(["jq", "ripgrep"]);
    expect(byPackage.get("jq")?.op).toBe("uninstall");
  });
});
