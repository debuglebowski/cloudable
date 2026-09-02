import type * as schema from "@cloudable/schema";
import { events, accessCommandRecorded } from "@cloudable/schema";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Data, Effect } from "effect";
import { type EvidenceRecord, projectEvent } from "./projection";

type DbHandle = PostgresJsDatabase<typeof schema>;

export class EvidenceQueryError extends Data.TaggedError("EvidenceQueryError")<{
  reason: string;
  cause?: unknown;
}> {}

export interface EvidencePageParams {
  orgId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface EvidencePage {
  data: ReadonlyArray<EvidenceRecord>;
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

export const EVIDENCE_DEFAULT_PAGE_LIMIT = 25;
export const EVIDENCE_MAX_PAGE_LIMIT = 100;

/**
 * Reads a cursor-paginated page of the normalised evidence projection for
 * an org, newest first.
 *
 * This is a read-only query over the append-only `events` table — nothing
 * here writes, updates, or deletes a row, and no second copy of the events
 * is persisted. `id` is a ULID (ordered by creation), so
 * `ORDER BY id DESC` with an `id < cursor` predicate is a stable, gapless
 * "newest first" cursor without needing a separate offset or timestamp tie
 * -breaker.
 *
 * `access.command_recorded` rows (tier-3 shell capture, a separate
 * high-volume table — see `@cloudable/schema`) are looked up by
 * `correlationId` for the page's events and attached as a count/pointer,
 * never merged into the returned rows themselves.
 */
export const queryEvidencePage = (
  db: DbHandle,
  params: EvidencePageParams,
): Effect.Effect<EvidencePage, EvidenceQueryError> =>
  Effect.gen(function* () {
    const limit = Math.min(
      Math.max(params.limit ?? EVIDENCE_DEFAULT_PAGE_LIMIT, 1),
      EVIDENCE_MAX_PAGE_LIMIT,
    );

    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(events)
          .where(
            params.cursor
              ? and(eq(events.orgId, params.orgId), lt(events.id, params.cursor))
              : eq(events.orgId, params.orgId),
          )
          .orderBy(desc(events.id))
          .limit(limit + 1),
      catch: (cause) => new EvidenceQueryError({ reason: "events_query_failed", cause }),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const correlationIds = [...new Set(page.map((row) => row.correlationId))];
    const commandRecordingCounts =
      correlationIds.length === 0
        ? new Map<string, number>()
        : yield* Effect.tryPromise({
            try: async () => {
              const matches = await db
                .select({ correlationId: accessCommandRecorded.correlationId })
                .from(accessCommandRecorded)
                .where(inArray(accessCommandRecorded.correlationId, correlationIds));
              const counts = new Map<string, number>();
              for (const match of matches) {
                counts.set(match.correlationId, (counts.get(match.correlationId) ?? 0) + 1);
              }
              return counts;
            },
            catch: (cause) =>
              new EvidenceQueryError({ reason: "command_recording_lookup_failed", cause }),
          });

    const data = page.map((row) =>
      projectEvent(row, commandRecordingCounts.get(row.correlationId) ?? 0),
    );

    return {
      data,
      pageInfo: {
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        hasMore,
      },
    } satisfies EvidencePage;
  });
