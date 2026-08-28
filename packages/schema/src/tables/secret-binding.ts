import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { orgs } from "./org";

/**
 * Records WHICH secret ref (a pointer into the customer's own Azure Key
 * Vault or 1Password store) is bound to which scope — org, template,
 * machine, or a specific person. Metadata only: the pointer/reference is
 * stored here, NEVER the secret value itself (CLAUDE.md invariant #8,
 * "Cloudable injects secrets, never stores them.") — fetching happens at
 * runtime via `SecretsProvider`/`injectSecretsForSession`
 * (`apps/control-plane/src/services/secrets/inject.ts`), and the fetched
 * value never comes back through this table.
 *
 * Scope precedence/resolution mirrors `setting_values`
 * (`resolve-setting.ts`), extended with a `person` scope for secrets bound
 * to an individual user rather than an org/template/machine (spec §12:
 * "per template or per user").
 */
export const secretBindings = pgTable(
  "secret_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    scopeType: text("scope_type", { enum: ["org", "template", "machine", "person"] }).notNull(),
    scopeId: uuid("scope_id").notNull(),
    // Target name the fetched value should be injected as (e.g. an env var
    // name) — interpretation is entirely up to the caller injecting it into
    // a live session; this table never resolves or acts on it.
    key: text("key").notNull(),
    provider: text("provider", { enum: ["azure_key_vault", "onepassword"] }).notNull(),
    // Pointer into the customer's own secret store — see `SecretRef` in
    // `apps/control-plane/src/services/SecretsProvider.ts`.
    pointer: text("pointer").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    index("secret_bindings_scope_idx").on(table.scopeType, table.scopeId),
    // Partial: only currently-active bindings must be unique per
    // (scope, key), so a key can be rebound to a new pointer after its
    // prior binding was soft-removed (removedAt set) without a rename.
    uniqueIndex("secret_bindings_scope_key_idx")
      .on(table.scopeType, table.scopeId, table.key)
      .where(sql`${table.removedAt} is null`),
  ],
);
