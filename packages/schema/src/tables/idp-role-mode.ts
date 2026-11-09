import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The deployment's roles-from-the-IdP mode, as last applied. One row, `id = 'deployment'`.
 *
 * Exists so turning the mode on is a persisted, one-time event rather than something each boot
 * redoes: the control plane compares its config with this row at startup, and only when the mode
 * goes from off to on, or the claim or mapping changes while on, does it move `activatedAt`
 * forward. Every human credential issued before `activatedAt` is then refused, and every person
 * needs a verified SSO sign-in after it. Restarts with unchanged config change nothing.
 */
export const idpRoleMode = pgTable("idp_role_mode", {
  id: text("id").primaryKey(),
  enabled: boolean("enabled").notNull(),
  /** SHA-256 of the claim name and mapping in force. Null while the mode is off. */
  configFingerprint: text("config_fingerprint"),
  /** When the mode was last switched on or its claim/mapping changed. Null while never on. */
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
