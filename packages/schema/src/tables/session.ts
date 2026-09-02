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
  /** The signed token minted for this session (`tunnel/session-token.ts`), replayed
   * server-side on attach — the browser never resupplies it directly. Nullable:
   * SSH-certificate sessions don't mint one of these. */
  sessionToken: text("session_token"),
  /** Set once, on the first successful daemon `attached` ack — distinct from `startedAt`
   * (when the token was minted, which may be before a browser ever connects). */
  attachedAt: timestamp("attached_at", { withTimezone: true }),
  /** Why `endedAt` was set: `person_ended` | `policy_terminated` | `connection_lost`. Nullable
   * for the same reason `endedAt` is — an in-progress session has neither. */
  terminationReason: text("termination_reason"),
});
