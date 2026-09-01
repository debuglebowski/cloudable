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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
});
