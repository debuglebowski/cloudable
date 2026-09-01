import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { orgs } from "@cloudable/schema";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { isDbReachable } from "../../testing/db-reachable";
import {
  PersonNotFoundError,
  createPerson,
  listPeopleByOrg,
  setPersonActive,
  updatePerson,
} from "./people";

// Real Postgres, not a fake — the behaviour under test is `findById`'s own
// cross-tenant scoping (the `orgId` check added alongside real session
// auth), which only matters against the real `people` table.
const databaseUrl = config.databaseUrl;
const dbReachable = await isDbReachable(databaseUrl);

describe.skipIf(!dbReachable)("people — tenant isolation (requires Postgres)", () => {
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

  const run = <A, E>(effect: Effect.Effect<A, E, Db>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  const runFail = <A, E>(effect: Effect.Effect<A, E, Db>) =>
    Effect.runPromise(Effect.provide(Effect.flip(effect), TestLayer));

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  }

  test("updatePerson succeeds for its own org, and fails with PersonNotFoundError for a different org", async () => {
    const org = await seedOrg();
    const otherOrg = await seedOrg();

    const person = await run(
      createPerson({
        orgId: org.id,
        email: `p-${crypto.randomUUID()}@example.com`,
        role: "member",
      }),
    );

    const updated = await run(updatePerson({ personId: person.id, orgId: org.id, role: "owner" }));
    expect(updated.role).toBe("owner");

    const error = await runFail(
      updatePerson({ personId: person.id, orgId: otherOrg.id, role: "intruder" }),
    );
    expect(error).toBeInstanceOf(PersonNotFoundError);

    // The wrong-org call above didn't change anything — still "owner" from
    // the real update, not "intruder".
    const rows = await run(listPeopleByOrg(org.id));
    expect(rows.find((r) => r.id === person.id)?.role).toBe("owner");
  });

  test("setPersonActive against another org's person fails with PersonNotFoundError, and doesn't deactivate them", async () => {
    const org = await seedOrg();
    const otherOrg = await seedOrg();

    const person = await run(
      createPerson({
        orgId: org.id,
        email: `p-${crypto.randomUUID()}@example.com`,
        role: "member",
      }),
    );

    const error = await runFail(
      setPersonActive({ personId: person.id, orgId: otherOrg.id, active: false }),
    );
    expect(error).toBeInstanceOf(PersonNotFoundError);

    const rows = await run(listPeopleByOrg(org.id));
    expect(rows.find((r) => r.id === person.id)?.active).toBe(true);
  });

  test("listPeopleByOrg never returns another org's rows", async () => {
    const org = await seedOrg();
    const otherOrg = await seedOrg();
    await run(
      createPerson({
        orgId: org.id,
        email: `p-${crypto.randomUUID()}@example.com`,
        role: "member",
      }),
    );
    await run(
      createPerson({
        orgId: otherOrg.id,
        email: `p-${crypto.randomUUID()}@example.com`,
        role: "member",
      }),
    );

    const rows = await run(listPeopleByOrg(org.id));
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.orgId === org.id)).toBe(true);
  });
});
