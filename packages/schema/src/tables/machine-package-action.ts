import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * One request to install or uninstall a package on one machine.
 *
 * This is the first thing in Cloudable that asks a machine to change itself.
 * Everything else that mutates a machine — create, archive, restart, reimage —
 * goes through the cloud provider's API with the agent uninvolved. A package
 * install has to happen inside the OS, so the work is handed to the agent on
 * its next poll and the outcome comes back on its next report.
 *
 * That asynchrony is why this has a real lifecycle, unlike `upgrade_attempts`
 * (the closest precedent), which records a terminal outcome because its work
 * finishes inside one request:
 *
 *   pending -> running -> succeeded
 *                      -> failed
 *                      -> expired
 *
 * `pending` is enqueued and not yet collected. `running` means a poll handed it
 * to the agent. `expired` means the agent took it and never reported back
 * within `ACTION_EXPIRY_MS` — an agent that died mid-install, or a machine that
 * went away. Expiry is deliberately visible rather than a silent retry: the
 * package may well be half-installed, and quietly running `apt-get` again is
 * not something to do behind someone's back.
 *
 * Rows are operational state and are updated in place. The append-only rule
 * (invariant 2) governs `events`, and each transition here emits one.
 */
export const machinePackageActions = pgTable(
  "machine_package_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    machineId: uuid("machine_id").notNull(),
    packageName: text("package_name").notNull(),
    op: text("op", { enum: ["install", "uninstall"] }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed", "expired"],
    })
      .notNull()
      .default("pending"),
    /**
     * The version pin in force when this action was requested, copied rather
     * than read live from the manifest: an install that ran against pin "24"
     * must still say so in the record after someone edits the pin to "25".
     * Null means no pin, i.e. whatever the distro's repo offers.
     */
    versionPin: text("version_pin"),
    // Always a person. Nothing enqueues these on its own — that is the whole
    // point of the design (invariants 4 and 5: nothing installs or removes
    // software without someone asking for it).
    requestedByPersonId: uuid("requested_by_person_id").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when a poll hands the action to the agent. The expiry clock runs
    // from here, not from `requestedAt` — a machine that is asleep or slow to
    // poll has not failed at anything.
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // The agent's own stderr tail on a failure, truncated. Shown verbatim:
    // "E: Unable to locate package foo" is the answer, and paraphrasing it
    // into "install failed" helps nobody.
    failureReason: text("failure_reason"),
    correlationId: text("correlation_id").notNull(),
  },
  (table) => [
    // The poll's own query: this machine's collectable work, oldest first.
    index("machine_package_actions_machine_status_idx").on(table.machineId, table.status),
  ],
);
