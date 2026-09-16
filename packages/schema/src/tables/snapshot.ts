import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** A point-in-time snapshot of a machine, taken on archive, upgrade, or manual request. */
export const snapshots = pgTable("snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  machineId: uuid("machine_id").notNull(),
  trigger: text("trigger", { enum: ["archive", "upgrade", "manual"] }).notNull(),
  // Nullable: inherited from the machine's own region, which is itself
  // nullable for providers with no region concept (docker/fake).
  region: text("region"),
  // The real total across `capturedDisks`, read back from the provider. Rows written
  // before real snapshots existed carry a hardcoded 32 GiB placeholder instead — every
  // one of them reports the same size, which is where the console's identical "34.4 GB"
  // on every snapshot came from.
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  // "full" captures the OS disk AND the persistent disk, so the machine can be put back
  // exactly as it was. "shallow" captures only the persistent disk — smaller and faster,
  // with the OS rebuilt from its image instead.
  //
  // Distinct from `snapshot.restored`'s `mode` ("data" | "config" | "full"), which is
  // what a RESTORE writes back. This is what the snapshot CAPTURED. The two vocabularies
  // share the word "full" and mean different things: a "shallow" snapshot can never
  // serve a "full"-mode restore, because there is no OS disk in it.
  // What the snapshot actually stores, as the machine measured its own filesystem just
  // before the copy was taken. This is the number a person means by "how big is it":
  // a provider bills a full snapshot on used data, so this is also what it costs.
  //
  // Null when the machine never reported a measurement — an older agent, or a machine
  // whose infrastructure was already gone. Null means "not measured", never "empty";
  // `sizeBytes` (provisioned) is the fallback to display, clearly labelled as such.
  usedBytes: bigint("used_bytes", { mode: "number" }),
  scope: text("scope", { enum: ["full", "shallow"] })
    .notNull()
    .default("full"),
  // One entry per disk the provider actually copied:
  // `{ kind: "os" | "data", externalId: string, sizeBytes: number }`.
  //
  // Empty on every row written before snapshots became real. Such a row points at
  // nothing in the cloud: it can neither be restored from nor deleted at expiry, because
  // there is nothing to aim either operation at. Six of them exist in production.
  capturedDisks: jsonb("captured_disks").notNull().default(sql`'[]'::jsonb`),
  containsData: boolean("contains_data").notNull().default(true),
  containsConfig: boolean("contains_config").notNull().default(true),
  legalHold: boolean("legal_hold").notNull().default(false),
  legalHoldReason: text("legal_hold_reason"),
  retentionDays: integer("retention_days").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Set by the expiry sweep (`expiry/daemon.ts`). NOTE: the sweep sets this and emits
  // `snapshot.expired`; it does NOT yet delete anything at the provider — see
  // `docs/lifecycle.md`. So this means "past retention", not "data destroyed".
  expiredAt: timestamp("expired_at", { withTimezone: true }),
});
