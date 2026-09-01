import { authAccount, authSession, authUser, authVerification } from "@cloudable/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "./config";

// Minimal working BetterAuth baseline (email/password only). Full multi-IdP
// OIDC federation (per docs/cloud-auth.md) is a later feature unit's job —
// this just gets a real, working BetterAuth instance mounted.
//
// Deviation from the literal instruction to reuse "the same" connection as
// `db/layer.ts`'s `DbLive`: that connection is opened lazily inside a
// `Layer.scoped` Effect (only available once the Effect runtime boots),
// while BetterAuth needs a plain, synchronous db handle at module-load
// time. This opens a second `postgres()` connection pointed at the same
// `DATABASE_URL` instead — same database, different client instance. A
// future feature unit may thread the Effect-managed connection through the
// layer graph instead, if that turns out to matter.
const authSql = postgres(config.databaseUrl);
const authDb = drizzle(authSql);

export const auth = betterAuth({
  // The drizzle adapter's own model names (`user`/`session`/`account`/
  // `verification`) are mapped explicitly to this build's `auth_`-prefixed
  // tables (`packages/schema/src/tables/auth-*.ts`) — those are named with
  // the prefix specifically to avoid colliding with the pre-existing
  // `sessions` table (SSH/terminal access) and the generic term "session"
  // being heavily overloaded elsewhere in this codebase, so the adapter
  // can't infer the mapping from `db._.fullSchema` by bare model name alone.
  database: drizzleAdapter(authDb, {
    provider: "pg",
    schema: {
      user: authUser,
      session: authSession,
      account: authAccount,
      verification: authVerification,
    },
  }),
  secret: config.betterAuthSecret,
  baseURL: config.betterAuthUrl,
  // BetterAuth's own CSRF/origin check (separate from `HttpMiddleware.cors`
  // in server.ts) rejects any request that carries a session cookie unless
  // its `Origin` is in this list — every request after the very first
  // sign-in click, in practice. Without this, real browser sessions break
  // immediately after login (sign-out, and any later `/sign-in` retry,
  // all 403 "Invalid origin" the moment a cookie is already set).
  trustedOrigins: [config.consoleOrigin],
  emailAndPassword: { enabled: true },
});
