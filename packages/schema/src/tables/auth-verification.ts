import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * BetterAuth's own `verification` table — short-lived tokens (email
 * verification, password reset, etc.). Field set from `getSchema()`.
 */
export const authVerification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
