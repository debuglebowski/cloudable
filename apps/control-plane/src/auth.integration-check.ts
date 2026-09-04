import { afterAll, describe, expect, test } from "bun:test";
import { orgs, people } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { auth } from "./auth";
import { config } from "./config";

/**
 * Regression coverage for the root-cause fix in `auth.ts`'s
 * `databaseHooks.user.create.before`: this is what stops another orphaned
 * `dev@cloudable.local` — a BetterAuth account that authenticates cleanly
 * forever but can never resolve through `CurrentUserAuthentication`, since
 * that middleware requires a matching `people` row — from ever being
 * created again.
 *
 * Named `.integration-check.ts` (this repo's convention for "needs real
 * infra"), but deliberately NOT the usual `startTestDb()` testcontainer:
 * `auth.ts`'s BetterAuth instance is a module-level singleton bound to
 * `config.databaseUrl` at import time, not swappable via DI, so this needs
 * a real Postgres already reachable there — `config.databaseUrl` defaults
 * to exactly the same local dev database every other script in this repo
 * already assumes is running (`postgres://cloudable:cloudable@localhost:
 * 5442/cloudable`), not a throwaway container.
 */
describe("auth sign-up requires a matching person", () => {
  // A second connection to the same database `auth.ts`'s own `authDb`
  // already opened, same reasoning as that file's own doc comment on why
  // it can't just reuse `db/layer.ts`'s `DbLive`.
  const sql = postgres(config.databaseUrl);
  const db = drizzle(sql);

  const createdAuthUserIds: string[] = [];
  const createdOrgIds: string[] = [];

  afterAll(async () => {
    for (const orgId of createdOrgIds) {
      await db.delete(people).where(eq(people.orgId, orgId));
      await db.delete(orgs).where(eq(orgs.id, orgId));
    }
    for (const id of createdAuthUserIds) {
      await sql`delete from auth_user where id = ${id}`;
    }
    await sql.end();
  });

  test("rejects sign-up for an email with no matching person", async () => {
    const email = `no-person-${crypto.randomUUID()}@example.com`;
    await expect(
      auth.api.signUpEmail({
        body: { email, password: "irrelevant-1234", name: "Nobody" },
      }),
    ).rejects.toThrow();
  });

  test("allows sign-up for an email with a matching person", async () => {
    const email = `has-person-${crypto.randomUUID()}@example.com`;
    const [org] = await db.insert(orgs).values({ name: "test-org" }).returning();
    if (!org) throw new Error("expected an inserted org row back");
    createdOrgIds.push(org.id);
    await db.insert(people).values({ orgId: org.id, email });

    const result = await auth.api.signUpEmail({
      body: { email, password: "irrelevant-1234", name: "Has Person" },
    });
    expect(result.user.email).toBe(email);
    createdAuthUserIds.push(result.user.id);
  });
});
