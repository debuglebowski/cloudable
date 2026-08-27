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
//
// BetterAuth also owns its own tables (user/session/account/verification),
// which do not exist yet in `@cloudable/schema`'s migrations. Until a
// future feature unit adds them (e.g. via the BetterAuth CLI's schema
// generation), any BetterAuth endpoint that actually touches the database
// will fail at request time — this file only guarantees construction, not
// a working auth flow end to end.
const authSql = postgres(config.databaseUrl);
const authDb = drizzle(authSql);

export const auth = betterAuth({
  database: drizzleAdapter(authDb, { provider: "pg" }),
  secret: config.betterAuthSecret,
  baseURL: config.betterAuthUrl,
  emailAndPassword: { enabled: true },
});
