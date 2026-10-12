import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type * as schema from "@cloudable/schema";
import { orgs, people } from "@cloudable/schema";
import { inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import { Db } from "../../db/layer";
import { connectAndMigrate } from "../../test-support/db";
import { isDbReachable } from "../../testing/db-reachable";
import {
  AdminRoleRequiredError,
  requireAdmin,
  requireAdminToChangeRole,
  requireAdminToCreateWithRole,
  roleChangeNeedsAdmin,
} from "./authorization";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";

describe("roleChangeNeedsAdmin", () => {
  test("adding an ordinary member needs no admin, handing out an admin role does", () => {
    expect(roleChangeNeedsAdmin({ currentRole: null, nextRole: "member" })).toBe(false);
    expect(roleChangeNeedsAdmin({ currentRole: null, nextRole: "engineer" })).toBe(false);
    expect(roleChangeNeedsAdmin({ currentRole: null, nextRole: "owner" })).toBe(true);
    expect(roleChangeNeedsAdmin({ currentRole: null, nextRole: "admin" })).toBe(true);
  });

  test("changing a role needs an admin in either direction", () => {
    expect(roleChangeNeedsAdmin({ currentRole: "member", nextRole: "owner" })).toBe(true);
    expect(roleChangeNeedsAdmin({ currentRole: "owner", nextRole: "member" })).toBe(true);
    expect(roleChangeNeedsAdmin({ currentRole: "member", nextRole: "engineer" })).toBe(true);
  });

  test("sending the role someone already has is not a change", () => {
    expect(roleChangeNeedsAdmin({ currentRole: "member", nextRole: "member" })).toBe(false);
    expect(roleChangeNeedsAdmin({ currentRole: "owner", nextRole: "owner" })).toBe(false);
  });
});

describe.skipIf(!(await isDbReachable(databaseUrl)))(
  "admin authorization (requires Postgres at DATABASE_URL)",
  () => {
    let db: PostgresJsDatabase<typeof schema>;
    let close: () => Promise<void>;
    const orgIds: string[] = [];

    beforeAll(async () => {
      const conn = await connectAndMigrate(databaseUrl);
      db = conn.db;
      close = conn.close;
    });

    afterAll(async () => {
      if (!close) return;
      if (orgIds.length > 0) {
        await db.delete(people).where(inArray(people.orgId, orgIds));
        await db.delete(orgs).where(inArray(orgs.id, orgIds));
      }
      await close();
    });

    async function seedOrg() {
      const [org] = await db
        .insert(orgs)
        .values({ name: `org-${crypto.randomUUID()}` })
        .returning();
      if (!org) throw new Error("seed failed");
      orgIds.push(org.id);
      return org.id;
    }

    async function seedPerson(orgId: string, role: string, active = true) {
      const [person] = await db
        .insert(people)
        .values({ orgId, email: `p-${crypto.randomUUID()}@test.local`, role, active })
        .returning();
      if (!person) throw new Error("seed failed");
      return person;
    }

    const run = <A, E>(effect: Effect.Effect<A, E, Db>) =>
      Effect.runPromise(Effect.either(Effect.provide(effect, Layer.succeed(Db, db))));

    test("an active owner or admin of the org passes", async () => {
      const orgId = await seedOrg();
      for (const role of ["owner", "admin"]) {
        const person = await seedPerson(orgId, role);
        expect((await run(requireAdmin(person.id, orgId, "no")))._tag).toBe("Right");
      }
    });

    test("a member, a deactivated owner, someone from another org and a stranger do not", async () => {
      const orgId = await seedOrg();
      const otherOrg = await seedOrg();
      const refused = [
        (await seedPerson(orgId, "member")).id,
        (await seedPerson(orgId, "owner", false)).id,
        (await seedPerson(otherOrg, "owner")).id,
        crypto.randomUUID(),
        "not-a-uuid",
      ];
      for (const id of refused) {
        const result = await run(requireAdmin(id, orgId, "Only an admin can do this."));
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(AdminRoleRequiredError);
          expect((result.left as AdminRoleRequiredError).reason).toBe("Only an admin can do this.");
        }
      }
    });

    test("the role is read fresh: a demoted owner loses admin at once", async () => {
      const orgId = await seedOrg();
      const person = await seedPerson(orgId, "owner");
      expect((await run(requireAdmin(person.id, orgId, "no")))._tag).toBe("Right");
      await db
        .update(people)
        .set({ role: "member" })
        .where(inArray(people.id, [person.id]));
      expect((await run(requireAdmin(person.id, orgId, "no")))._tag).toBe("Left");
    });

    describe("adding a person", () => {
      test("anyone may add a member", async () => {
        const orgId = await seedOrg();
        const member = await seedPerson(orgId, "member");
        const actor = { personId: member.id, orgId };
        expect((await run(requireAdminToCreateWithRole(actor, "member")))._tag).toBe("Right");
      });

      test("only an admin may give an admin role", async () => {
        const orgId = await seedOrg();
        const member = await seedPerson(orgId, "member");
        const owner = await seedPerson(orgId, "owner");
        for (const role of ["owner", "admin"]) {
          expect(
            (await run(requireAdminToCreateWithRole({ personId: member.id, orgId }, role)))._tag,
          ).toBe("Left");
          expect(
            (await run(requireAdminToCreateWithRole({ personId: owner.id, orgId }, role)))._tag,
          ).toBe("Right");
        }
      });
    });

    describe("changing a role", () => {
      test("a member cannot promote themselves, or demote an owner", async () => {
        const orgId = await seedOrg();
        const member = await seedPerson(orgId, "member");
        const owner = await seedPerson(orgId, "owner");
        const actor = { personId: member.id, orgId };

        expect((await run(requireAdminToChangeRole(actor, member, "owner")))._tag).toBe("Left");
        expect((await run(requireAdminToChangeRole(actor, owner, "member")))._tag).toBe("Left");
      });

      test("an admin can change any role", async () => {
        const orgId = await seedOrg();
        const member = await seedPerson(orgId, "member");
        const owner = await seedPerson(orgId, "owner");
        const actor = { personId: owner.id, orgId };
        expect((await run(requireAdminToChangeRole(actor, member, "admin")))._tag).toBe("Right");
        expect((await run(requireAdminToChangeRole(actor, owner, "member")))._tag).toBe("Right");
      });

      test("sending the role someone already has needs nothing", async () => {
        const orgId = await seedOrg();
        const member = await seedPerson(orgId, "member");
        const actor = { personId: member.id, orgId };
        expect((await run(requireAdminToChangeRole(actor, member, "member")))._tag).toBe("Right");
      });

      test("a person who is not there, or is in another org, is left for the update to report as not found", async () => {
        const orgId = await seedOrg();
        const otherOrg = await seedOrg();
        const member = await seedPerson(orgId, "member");
        const foreign = await seedPerson(otherOrg, "member");
        const actor = { personId: member.id, orgId };
        expect((await run(requireAdminToChangeRole(actor, undefined, "owner")))._tag).toBe("Right");
        expect((await run(requireAdminToChangeRole(actor, foreign, "owner")))._tag).toBe("Right");
      });
    });
  },
);
