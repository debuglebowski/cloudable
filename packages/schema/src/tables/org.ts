import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** An organization — the top-level tenant. Every person and machine belongs to exactly one. */
export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
