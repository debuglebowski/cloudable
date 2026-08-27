import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** An interactive terminal or SSH session against a machine. */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  machineId: uuid("machine_id").notNull(),
  personId: uuid("person_id").notNull(),
  method: text("method", { enum: ["terminal", "ssh"] }).notNull(),
  osUser: text("os_user").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
});
