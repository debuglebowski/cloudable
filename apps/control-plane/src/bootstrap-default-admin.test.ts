import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import type * as schema from "@cloudable/schema";
import { authUser, orgs, people } from "@cloudable/schema";
import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { bootstrapDefaultAdmin } from "./bootstrap-default-admin";
import { connectAndMigrate } from "./test-support/db";

// Real Postgres, not a fake — same convention/skip-guard as
// `domain/machine/MachineService.test.ts`: `bun test`/`test:unit` must stay
// green with no DB running.
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";

function isReachable(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

const { hostname, port } = new URL(databaseUrl);
const postgresReachable = await isReachable(hostname, Number(port) || 5432, 2000);

// A real (throwaway) password — BetterAuth's default `emailAndPassword`
// config enforces a minimum length, so a trivial one would fail sign-up for
// reasons unrelated to what these tests check.
const PASSWORD = "Test-Password-1234!";

describe.skipIf(!postgresReachable)(
  "bootstrapDefaultAdmin (requires Postgres at DATABASE_URL)",
  () => {
    let close: () => Promise<void>;
    let db: PostgresJsDatabase<typeof schema>;
    const createdOrgIds: string[] = [];
    const createdEmails: string[] = [];

    beforeAll(async () => {
      const conn = await connectAndMigrate(databaseUrl);
      db = conn.db;
      close = conn.close;
    });

    afterAll(async () => {
      if (!close) return;
      if (createdEmails.length > 0) {
        await db.delete(authUser).where(inArray(authUser.email, createdEmails)); // cascades to auth_account
        await db.delete(people).where(inArray(people.email, createdEmails));
      }
      if (createdOrgIds.length > 0) {
        await db.delete(orgs).where(inArray(orgs.id, createdOrgIds));
      }
      await close();
    });

    async function seedOrg() {
      const [org] = await db
        .insert(orgs)
        .values({ name: `org-${crypto.randomUUID()}` })
        .returning();
      if (!org) throw new Error("seed failed");
      createdOrgIds.push(org.id);
      return org;
    }

    function freshEmail() {
      const email = `bootstrap-${crypto.randomUUID()}@example.com`;
      createdEmails.push(email);
      return email;
    }

    test("creates an org, a person (role owner), and a working account when none exist", async () => {
      const email = freshEmail();

      await bootstrapDefaultAdmin(email, PASSWORD);

      const [person] = await db.select().from(people).where(eq(people.email, email)).limit(1);
      expect(person?.role).toBe("owner");
      expect(person?.orgId).toBeTruthy();

      const [org] = await db
        .select()
        .from(orgs)
        .where(eq(orgs.id, person?.orgId ?? ""))
        .limit(1);
      expect(org).toBeTruthy();

      const [account] = await db.select().from(authUser).where(eq(authUser.email, email)).limit(1);
      expect(account).toBeTruthy();
    });

    test("is idempotent — a second call with the same email is a no-op", async () => {
      const email = freshEmail();

      await bootstrapDefaultAdmin(email, PASSWORD);
      await bootstrapDefaultAdmin(email, PASSWORD);

      const personRows = await db.select().from(people).where(eq(people.email, email));
      expect(personRows).toHaveLength(1);

      const authRows = await db.select().from(authUser).where(eq(authUser.email, email));
      expect(authRows).toHaveLength(1);
    });

    test("reuses an existing person row that has no matching account yet", async () => {
      const org = await seedOrg();
      const email = freshEmail();
      const [existingPerson] = await db
        .insert(people)
        .values({ orgId: org.id, email, source: "manual", active: true, role: "owner" })
        .returning();

      await bootstrapDefaultAdmin(email, PASSWORD);

      const personRows = await db.select().from(people).where(eq(people.email, email));
      expect(personRows).toHaveLength(1);
      expect(personRows[0]?.id).toBe(existingPerson?.id ?? "");

      const [account] = await db.select().from(authUser).where(eq(authUser.email, email)).limit(1);
      expect(account).toBeTruthy();
    });

    test("does nothing when email or password is unset", async () => {
      const email = `bootstrap-unset-${crypto.randomUUID()}@example.com`;

      await bootstrapDefaultAdmin(undefined, PASSWORD);
      await bootstrapDefaultAdmin(email, undefined);
      await bootstrapDefaultAdmin(undefined, undefined);

      const personRows = await db.select().from(people).where(eq(people.email, email));
      expect(personRows).toHaveLength(0);
    });
  },
);
