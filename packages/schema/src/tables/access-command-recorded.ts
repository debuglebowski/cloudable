import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// High-volume tier-3 telemetry (every shell command run in a session), kept
// deliberately separate from the `events` catalogue so this table's write
// volume never dominates the compliance-query index on `events`. It is not
// part of the append-only audit stream and is not a public event type.
export const accessCommandRecorded = pgTable(
  "access_command_recorded",
  {
    id: text("id").primaryKey(),
    machineId: uuid("machine_id").notNull(),
    osUser: text("os_user").notNull(),
    command: text("command").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    correlationId: text("correlation_id").notNull(),
  },
  (table) => [index("access_command_recorded_machine_occurred_idx").on(table.machineId, table.occurredAt)],
);
