import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** An interactive session against a machine: a terminal, an SSH connection, a
 * file-browsing session (`method: "files"`, see `docs/access.md`), or a read-only
 * inspection of an archived machine's snapshot (`method: "snapshot_files"`, see
 * `docs/lifecycle.md`).
 *
 * `snapshot_files` is the one method with no machine behind it. It reads a disk
 * snapshot in the control plane rather than reaching a tunnel daemon, so it mints no
 * session token and never attaches. It is still a row here because everything that
 * makes a session governable — it shows on the Access page, it can be terminated, the
 * re-authorization sweep re-checks it, it emits `access.session_started`/`_ended` —
 * is keyed off this table rather than off the transport. */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  machineId: uuid("machine_id").notNull(),
  personId: uuid("person_id").notNull(),
  method: text("method", { enum: ["terminal", "ssh", "files", "snapshot_files"] }).notNull(),
  osUser: text("os_user").notNull(),
  /** The snapshot being inspected. Set only for `method: "snapshot_files"`, null for
   * every other method — a terminal session has a live machine, not a snapshot. The
   * machine id stays populated for both: a snapshot always belongs to one, and an
   * archived machine's row is never deleted. */
  snapshotId: uuid("snapshot_id"),
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
