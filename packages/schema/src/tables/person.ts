import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { orgs } from "./org";

/** A person — always the sole owner of any machine they hold. Never a shared identity.
 * `email` is globally unique (not just per-org): the real auth middleware resolves a
 * BetterAuth login (`auth_user.email`, itself globally unique) to exactly one `people`
 * row by email, so that lookup has to be unambiguous across the whole system. */
export const people = pgTable("people", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  email: text("email").notNull().unique(),
  source: text("source", { enum: ["manual", "scim"] })
    .notNull()
    .default("manual"),
  active: boolean("active").notNull().default(true),
  role: text("role").notNull().default("member"),
  // A flag on top of the role, not a role of its own: an approver may decide approval requests
  // (see `apps/control-plane/src/domain/authz/policy.ts`). Member or admin, either can be one.
  approver: boolean("approver").notNull().default(false),
  // Every credential issued to this person before this instant is refused: console sessions are
  // deleted when it is set, and a CLI token whose `iat` is older fails authentication. Set when an
  // admin changes the person's email, so a sign-in under the old address cannot outlive it.
  credentialsRevokedAt: timestamp("credentials_revoked_at", { withTimezone: true }),
  // Roles from the identity provider only: when this person's role last came from a verified
  // SAML assertion. With the mode on, every request is refused once it is older than the recheck
  // interval (at most an hour), until a fresh SSO sign-in sets it again. Null means never, or
  // that the last sign-in was refused. Unused with the mode off.
  idpRolesVerifiedAt: timestamp("idp_roles_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
});
