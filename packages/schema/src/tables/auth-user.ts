import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * BetterAuth's own `user` table — field set derived from the library's own
 * `getSchema()` (better-auth 1.7.2, `emailAndPassword` only, no plugins),
 * not hand-guessed from generic docs (see the auth work's own notes). Named
 * `auth_user`/`auth-user.ts` rather than the library's bare `user` to make
 * the distinction from `people` (the org-membership/ownership record this
 * resolves to by email) obvious at a glance — BetterAuth itself doesn't
 * care what the table is named as long as the adapter is told.
 */
export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
