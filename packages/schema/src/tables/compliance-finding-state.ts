import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Reserved, never-generated uuid standing in for "no machine" in
 * `machineId` below. Postgres treats NULL as distinct from NULL in a unique
 * index, which would make org-scoped (no single machine) findings
 * impossible to de-duplicate; storing this sentinel instead keeps the
 * column real `NOT NULL` and lets `machineId` participate in a genuine
 * unique constraint, so the upsert in `apps/control-plane/src/compliance/
 * finding-store.ts` can be a single atomic `INSERT ... ON CONFLICT DO
 * UPDATE` instead of a racy select-then-insert. Only `finding-store.ts`
 * should read or write this column — everything else goes through it.
 */
export const NO_MACHINE_SENTINEL = "00000000-0000-0000-0000-000000000000";

/**
 * Finding-age bookkeeping for compliance checks (spec §19 "Finding age").
 *
 * Compliance is computed live (§19: "Computed live from current fleet
 * state, not stored") — this table is not evidence and never substitutes
 * for re-running a check against `events`/current state. Its only job is
 * remembering the first time a given (check, org, machine, finding) tuple
 * was ever detected, so a finding that keeps recurring across evaluations
 * reports its true "open since" date instead of resetting to "now" on every
 * run.
 *
 * `detailKey` is a stable identifier derived from the finding's own detail
 * (e.g. a certificate id) — it's what disambiguates two distinct findings
 * that would otherwise collide on (checkId, orgId, machineId) alone.
 *
 * A row is deleted once its finding stops being detected (see
 * `clearResolvedFindings` in `apps/control-plane/src/compliance/
 * finding-store.ts`) — a resolved finding shouldn't keep aging forever in
 * the store. This never touches `events`, which stays append-only
 * (invariant #2).
 */
export const complianceFindingState = pgTable(
  "compliance_finding_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checkId: text("check_id").notNull(),
    orgId: uuid("org_id").notNull(),
    // NO_MACHINE_SENTINEL for a finding that isn't scoped to one machine —
    // see that constant's doc comment for why this isn't a nullable column.
    machineId: uuid("machine_id").notNull(),
    detailKey: text("detail_key").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // Stamped on every evaluation that still reports this finding, so a run
    // can tell "still open" apart from "no longer detected" without needing
    // to touch `events`.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Backs the atomic `ON CONFLICT` upsert in `finding-store.ts` — this is
    // the row identity for one open finding.
    uniqueIndex("compliance_finding_state_key_idx").on(
      table.checkId,
      table.orgId,
      table.machineId,
      table.detailKey,
    ),
  ],
);
