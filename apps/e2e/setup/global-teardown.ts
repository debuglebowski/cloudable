import { readFile, rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { connect, schema } from "./db";
import { E2E_USER_FILE, type E2eUser } from "./global-setup";

/**
 * Deletes exactly what `global-setup.ts` created, in FK order: `auth_user`
 * cascades to `auth_session`/`auth_account` (see those tables' `onDelete:
 * "cascade"`), but `people.org_id -> orgs.id` has no cascade, so `people`
 * must go before `orgs`. Runs even if a test failed — always deleting the
 * one org/person/login this run made, never a blanket sweep of e2e-looking
 * rows (a concurrent run's data must survive).
 */
export default async function globalTeardown() {
  const raw = await readFile(E2E_USER_FILE, "utf8").catch(() => undefined);
  if (!raw) return;
  const user = JSON.parse(raw) as E2eUser;

  const { client, db } = connect();
  try {
    await db.delete(schema.authUser).where(eq(schema.authUser.id, user.authUserId));
    await db.delete(schema.people).where(eq(schema.people.id, user.personId));
    await db.delete(schema.orgs).where(eq(schema.orgs.id, user.orgId));
  } finally {
    await client.end();
    await rm(E2E_USER_FILE, { force: true });
  }
}
