import type * as schema from "@cloudable/schema";
import { events, machines } from "@cloudable/schema";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Data, Effect } from "effect";
import { PACKAGE_SETTING_KEY_PREFIX, packageNameFromSettingKey } from "./manifest";

type DbHandle = PostgresJsDatabase<typeof schema>;

export class ManifestHistoryError extends Data.TaggedError("ManifestHistoryError")<{
  reason: "query_failed";
  cause?: unknown;
}> {}

/** One side of a change. `null` means the package had no entry at that point. */
export interface ManifestHistoryState {
  versionPin: string | null;
  pinned: boolean;
  excluded: boolean;
}

export interface ManifestHistoryEntry {
  /** The event's own id — a ULID, so descending id is descending time. */
  id: string;
  /** ISO 8601, matching the evidence API's own wire shape. */
  occurredAt: string;
  recordedAt: string;
  actorType: (typeof events.$inferSelect)["actorType"];
  actorId: string;
  correlationId: string;
  /** Which scope the edit was made at, not which scope currently wins resolution. */
  scope: "org" | "machine";
  packageName: string;
  previous: ManifestHistoryState | null;
  current: ManifestHistoryState | null;
}

export interface ManifestHistoryPage {
  items: ManifestHistoryEntry[];
  nextCursor: string | null;
}

export const MANIFEST_HISTORY_DEFAULT_LIMIT = 50;
export const MANIFEST_HISTORY_MAX_LIMIT = 200;

const HISTORY_EVENT_TYPES = ["machine.setting_changed", "org.setting_changed"] as const;

/**
 * Normalises both write paths' payloads onto one shape.
 *
 * The org path stores an `OrgPackageEntry` (`{ packageName, versionPin, pinned }`)
 * and the machine path stores `{ versionPin, pinned, excluded }`, so neither
 * side can be trusted to carry every field. Reading defensively here is also
 * what lets old rows — written before `excluded` existed — render as the
 * "not excluded" they were, instead of being dropped from the history.
 */
function toState(raw: unknown): ManifestHistoryState | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const value = raw as { versionPin?: unknown; pinned?: unknown; excluded?: unknown };
  return {
    versionPin: typeof value.versionPin === "string" ? value.versionPin : null,
    pinned: value.pinned === true,
    excluded: value.excluded === true,
  };
}

/**
 * Every package manifest change that affects one machine, newest first.
 *
 * Includes org-scope edits as well as this machine's own. An org edit changes
 * what the machine resolves to just as surely as a machine edit does, and
 * `org.setting_changed` carries `machineId: null`, so it can never reach a
 * machine-filtered view any other way. Rows carry `scope` so the two are
 * never confused for each other.
 *
 * Read-only over the append-only event log: this derives a view, it never
 * writes. Both write paths namespace their key as `package:<name>`
 * (`packageSettingKey`), which is what the `LIKE` below selects on — edits
 * recorded before that convention reached the machine path are keyed by a
 * bare package name and do not appear here. They are still in the raw event
 * stream on the Audit page.
 */
export const queryManifestHistory = (
  db: DbHandle,
  params: {
    orgId: string;
    machineId: string;
    limit?: number | undefined;
    cursor?: string | undefined;
  },
): Effect.Effect<ManifestHistoryPage, ManifestHistoryError> =>
  Effect.gen(function* () {
    const limit = Math.min(
      Math.max(params.limit ?? MANIFEST_HISTORY_DEFAULT_LIMIT, 1),
      MANIFEST_HISTORY_MAX_LIMIT,
    );

    // Scoped to the caller's org in the same predicate as the machine id, so a
    // machine from another org reads as an empty history rather than leaking
    // that it exists.
    const machineRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: machines.id })
          .from(machines)
          .where(and(eq(machines.id, params.machineId), eq(machines.orgId, params.orgId)))
          .limit(1),
      catch: (cause) => new ManifestHistoryError({ reason: "query_failed", cause }),
    });
    if (machineRows.length === 0) return { items: [], nextCursor: null };

    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(events)
          .where(
            and(
              eq(events.orgId, params.orgId),
              inArray(events.type, [...HISTORY_EVENT_TYPES]),
              sql`${events.payload}->>'key' LIKE ${`${PACKAGE_SETTING_KEY_PREFIX}%`}`,
              sql`(${events.machineId} = ${params.machineId} OR ${events.type} = 'org.setting_changed')`,
              ...(params.cursor ? [lt(events.id, params.cursor)] : []),
            ),
          )
          .orderBy(desc(events.id))
          .limit(limit + 1),
      catch: (cause) => new ManifestHistoryError({ reason: "query_failed", cause }),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const items: ManifestHistoryEntry[] = [];
    for (const row of page) {
      const payload = row.payload as { key?: unknown; previous?: unknown; current?: unknown };
      const packageName =
        typeof payload.key === "string" ? packageNameFromSettingKey(payload.key) : null;
      // The SQL already filtered on the prefix; this is the type narrowing.
      if (packageName === null) continue;
      items.push({
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        recordedAt: row.recordedAt.toISOString(),
        actorType: row.actorType,
        actorId: row.actorId,
        correlationId: row.correlationId,
        scope: row.type === "org.setting_changed" ? "org" : "machine",
        packageName,
        previous: toState(payload.previous),
        current: toState(payload.current),
      });
    }

    return { items, nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
  });
