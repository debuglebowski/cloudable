import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { orgs } from "./org";

/**
 * An apt repository outside Ubuntu's own that the org decided to trust. A row is written
 * only once its `apt_repository` approval is granted, and is never deleted: removing it
 * sets `removedAt`, so the record of what was trusted, and when, stays (invariant 6's
 * spirit). The agent writes each active row to the machine as
 * `/etc/apt/sources.list.d/cloudable-<id>.sources` with its key. A repository installs
 * nothing by itself. See docs/inheritance.md.
 */
export const aptRepositories = pgTable("apt_repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  suite: text("suite").notNull(),
  components: jsonb("components").$type<string[]>().notNull(),
  /** ASCII-armored public key. Public, not a secret. */
  signingKey: text("signing_key").notNull(),
  /** Upper-case hex fingerprint of the key's primary key, computed when it was asked for. */
  fingerprint: text("fingerprint").notNull(),
  addApprovalId: uuid("add_approval_id").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  removeApprovalId: uuid("remove_approval_id"),
  removedAt: timestamp("removed_at", { withTimezone: true }),
});
