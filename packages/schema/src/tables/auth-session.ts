import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { authUser } from "./auth-user";

/**
 * BetterAuth's own `session` table (a login session, i.e. a signed-in
 * browser) — deliberately distinct from `sessions` (`session.ts`), which is
 * an interactive terminal/SSH session against a *machine*. Field set from
 * `getSchema()`, same as `auth-user.ts`.
 */
export const authSession = pgTable("auth_session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => authUser.id, { onDelete: "cascade" }),
});
