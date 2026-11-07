import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as schema from "@cloudable/schema";
import { events, authSession, authUser, orgs, people } from "@cloudable/schema";
import { APIError } from "better-auth";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { CONFIGURED_IDP_PROVIDER_ID } from "../config";
import { isDbReachable } from "../testing/db-reachable";
import type { IdpRolesConfig } from "./config";
import { IDP_ROLE_CLAIM_FIELD, idpRoleProvisioning } from "./sign-in";

/**
 * The sign-in hook against a real Postgres: what a role claim does to `people`, the sessions, and
 * the audit trail. The SAML round trip itself is BetterAuth's; this starts where the plugin hands
 * over the user and the mapped claim (`provisionUser`).
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const postgresReachable = await isDbReachable(DATABASE_URL);

const config: IdpRolesConfig = {
  claim: "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
  mapping: {
    "Cloudable.Admin": "admin",
    "Cloudable.Member": "member",
    "Cloudable.Approver": "approver",
  },
  unmapped: "deny",
};
const LOGIN_URL = "https://cloudable.example.com/login";

describe.skipIf(!postgresReachable)("roles from the IdP at sign-in (requires Postgres)", () => {
  const sql = postgres(DATABASE_URL, { max: 2 });
  const db = drizzle(sql, { schema });
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const hook = idpRoleProvisioning(db, config, LOGIN_URL);
  let logs: string[] = [];
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    logs = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    spies.push(spyOn(console, "log").mockImplementation(capture));
    spies.push(spyOn(console, "warn").mockImplementation(capture));
  });
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  afterAll(async () => {
    if (orgIds.length > 0) {
      await db.delete(events).where(inArray(events.orgId, orgIds));
      await db.delete(people).where(inArray(people.orgId, orgIds));
      await db.delete(orgs).where(inArray(orgs.id, orgIds));
    }
    if (userIds.length > 0) await db.delete(authUser).where(inArray(authUser.id, userIds));
    await sql.end();
  });

  /** A person with a BetterAuth user and one live session, as after an earlier sign-in. */
  const seed = async (role = "member", approver = false) => {
    const [org] = await db
      .insert(orgs)
      .values({ name: `idp-roles-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("org insert failed");
    orgIds.push(org.id);
    const email = `${crypto.randomUUID()}@example.com`;
    const [person] = await db
      .insert(people)
      .values({ orgId: org.id, email, role, approver })
      .returning();
    if (!person) throw new Error("person insert failed");
    const userId = crypto.randomUUID();
    userIds.push(userId);
    const now = new Date();
    await db.insert(authUser).values({
      id: userId,
      name: email,
      email,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(authSession).values({
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: now,
      updatedAt: now,
    });
    return { orgId: org.id, personId: person.id, email, userId };
  };

  const signIn = (
    who: { email: string; userId: string },
    claim: unknown,
    providerId = CONFIGURED_IDP_PROVIDER_ID,
  ) =>
    hook.provisionUser({
      user: { id: who.userId, email: who.email },
      userInfo: { email: who.email, [IDP_ROLE_CLAIM_FIELD]: claim },
      provider: { providerId },
    });

  const personRow = async (personId: string) => {
    const [row] = await db.select().from(people).where(eq(people.id, personId));
    if (!row) throw new Error("person vanished");
    return row;
  };

  const personEvents = (orgId: string) =>
    db
      .select()
      .from(events)
      .where(
        and(
          eq(events.orgId, orgId),
          inArray(events.type, ["person.role_changed", "person.approver_changed"]),
        ),
      );

  const sessionCount = async (userId: string) =>
    (await db.select().from(authSession).where(eq(authSession.userId, userId))).length;

  /** The refusal: a redirect to the login page, never a resolved promise. */
  const expectRefused = async (promise: Promise<void>, code: string) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(APIError);
    const location = new Headers((error as APIError).headers).get("location") ?? "";
    expect((error as APIError).statusCode).toBe(302);
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(LOGIN_URL);
    expect(url.searchParams.get("error")).toBe(code);
  };

  test("runs on every sign-in, not only the first", () => {
    expect(hook.provisionUserOnEveryLogin).toBe(true);
  });

  test("grants the mapped role and approver flag, and records it as the IdP's doing", async () => {
    const who = await seed();
    await signIn(who, ["Cloudable.Admin", "Cloudable.Approver"]);

    const row = await personRow(who.personId);
    expect(row.role).toBe("admin");
    expect(row.approver).toBe(true);

    const recorded = await personEvents(who.orgId);
    expect(recorded.map((e) => e.type).sort()).toEqual([
      "person.approver_changed",
      "person.role_changed",
    ]);
    for (const event of recorded) {
      expect(event.actorType).toBe("idp");
      expect(event.actorId).toBe(CONFIGURED_IDP_PROVIDER_ID);
    }
    expect(recorded.find((e) => e.type === "person.role_changed")?.payload).toEqual({
      previous: "member",
      current: "admin",
    });
    expect(
      logs.some((l) => l.includes("[security] idp-role") && l.includes("is admin+approver")),
    ).toBe(true);
    expect(await sessionCount(who.userId)).toBe(1);
  });

  test("an unchanged sign-in writes no event but still logs", async () => {
    const who = await seed("admin");
    await signIn(who, "Cloudable.Admin");
    expect(await personEvents(who.orgId)).toEqual([]);
    expect(logs.filter((l) => l.includes("[security] idp-role")).length).toBe(1);
  });

  test("removing the role at the IdP removes it at the next sign-in", async () => {
    const who = await seed("admin", true);
    await signIn(who, ["Cloudable.Member"]);
    const row = await personRow(who.personId);
    expect(row.role).toBe("member");
    expect(row.approver).toBe(false);
  });

  test("no mapped role: sign-in refused, role taken away, every credential ended", async () => {
    const who = await seed("admin", true);
    const before = Date.now();
    await expectRefused(signIn(who, ["Some.Other.App"]), "no_mapped_role");

    const row = await personRow(who.personId);
    expect(row.role).toBe("member");
    expect(row.approver).toBe(false);
    expect(row.credentialsRevokedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(before - 1000);
    expect(await sessionCount(who.userId)).toBe(0);
    expect((await personEvents(who.orgId)).length).toBe(2);
    expect(logs.some((l) => l.includes("sign-in refused") && l.includes("Some.Other.App"))).toBe(
      true,
    );
  });

  test("no claim at all is refused too", async () => {
    const who = await seed();
    await expectRefused(signIn(who, undefined), "no_mapped_role");
  });

  test("a provider other than the configured one is refused and changes nothing", async () => {
    const who = await seed("member");
    await expectRefused(
      signIn(who, "Cloudable.Admin", "console-registered"),
      "role_provider_not_trusted",
    );
    expect((await personRow(who.personId)).role).toBe("member");
    expect(await personEvents(who.orgId)).toEqual([]);
  });

  test("the member fallback lets an unmapped person in as a member", async () => {
    const lenient = idpRoleProvisioning(db, { ...config, unmapped: "member" }, LOGIN_URL);
    const who = await seed("admin");
    await lenient.provisionUser({
      user: { id: who.userId, email: who.email },
      userInfo: { [IDP_ROLE_CLAIM_FIELD]: [] },
      provider: { providerId: CONFIGURED_IDP_PROVIDER_ID },
    });
    expect((await personRow(who.personId)).role).toBe("member");
    expect(await sessionCount(who.userId)).toBe(1);
  });
});
