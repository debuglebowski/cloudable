import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { authUser } from "./auth-user";

/**
 * `@better-auth/sso`'s own `ssoProvider` table — one row per registered
 * SAML/OIDC provider. Field set from `getSchema()` with the `sso({ saml: {} })`
 * plugin enabled (better-auth 1.7.2, `@better-auth/sso` 1.7.2), same method
 * as `auth-user.ts`/`auth-session.ts`. This build only ever populates
 * `samlConfig` (never `oidcConfig`) — see `docs/access.md`'s IdP section for
 * why SAML, not OIDC, was chosen.
 */
export const authSsoProvider = pgTable("auth_sso_provider", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: text("user_id").references(() => authUser.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text("domain").notNull(),
  // `.defaultNow()` here (unlike `auth-user.ts`/`auth-session.ts`, which
  // don't need it): `@better-auth/sso`'s own `/sso/register` handler builds
  // this row's insert directly against the raw adapter rather than through
  // whatever internal path auto-populates timestamps for the core
  // user/session models, so it never supplies these two fields itself —
  // confirmed against a real insert, which 23502'd on `created_at` without
  // this.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
