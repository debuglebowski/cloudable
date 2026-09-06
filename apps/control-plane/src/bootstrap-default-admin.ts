import * as schema from "@cloudable/schema";
import { authUser, orgs, people } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { auth } from "./auth";
import { config } from "./config";

/** Fixed, arbitrary — only needs to differ from `test-support/db.ts`'s
 * `MIGRATION_ADVISORY_LOCK_KEY` (847_291_003) to avoid colliding with it. */
const BOOTSTRAP_ADVISORY_LOCK_KEY = 394_812_207;

/**
 * Opt-in first-admin bootstrap for self-hosters (see `config.ts`'s
 * `defaultAdminEmail`/`defaultAdminPassword`): if set, and no BetterAuth
 * account exists yet for that email, create the org + person + account in
 * one shot. No-op otherwise.
 *
 * Gates on the BetterAuth account (not "is `people` empty") so a restart
 * after a partial failure — e.g. the `people` row got created but
 * `signUpEmail` below didn't run — retries the missing half instead of
 * silently wedging into the exact "person exists, no way to log in" state
 * this exists to avoid.
 *
 * Uses a single dedicated connection (not the shared pool) so the session-
 * scoped advisory lock actually covers every query below, including
 * `auth.api.signUpEmail` — a separate connection/module (`auth.ts`'s own
 * `authDb`) that can't be wrapped in one DB transaction with the rest.
 */
export async function bootstrapDefaultAdmin(
  email = config.defaultAdminEmail,
  password = config.defaultAdminPassword,
): Promise<void> {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail || !password) return;

  const sql = postgres(config.databaseUrl, { max: 1 });
  const db = drizzle(sql, { schema });
  try {
    await sql`select pg_advisory_lock(${BOOTSTRAP_ADVISORY_LOCK_KEY})`;

    const [existingAuthUser] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, normalizedEmail))
      .limit(1);
    if (existingAuthUser) return; // already bootstrapped, or the email is taken

    let [person] = await db.select().from(people).where(eq(people.email, normalizedEmail)).limit(1);
    if (!person) {
      let [org] = await db.select().from(orgs).limit(1);
      if (!org) {
        [org] = await db.insert(orgs).values({ name: "Default Org" }).returning();
      }
      if (!org) throw new Error("failed to find or create an org for the default admin");
      [person] = await db
        .insert(people)
        .values({
          orgId: org.id,
          email: normalizedEmail,
          source: "manual",
          active: true,
          role: "owner",
        })
        .returning();
    }

    await auth.api.signUpEmail({ body: { email: normalizedEmail, password, name: "Admin" } });
    console.log(`[bootstrap] created default admin ${normalizedEmail}`);
  } catch (err) {
    console.error(
      `[bootstrap] default admin bootstrap failed: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    await sql`select pg_advisory_unlock(${BOOTSTRAP_ADVISORY_LOCK_KEY})`.catch(() => {});
    await sql.end();
  }
}
