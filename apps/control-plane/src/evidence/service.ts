import type * as schema from "@cloudable/schema";
import { events } from "@cloudable/schema";
import { and, desc, eq, lt } from "drizzle-orm";
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
  /** Narrows the page to one machine's own events. Omitted means org-wide. */
  machineId?: string | undefined;
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
 * `machineId`, when given, is an equality predicate on the same table — the
 * console's per-machine Activity view needs *that machine's* newest events, and
 * paging an org-wide feed until enough of them turn up is not the same thing.
 * `events_org_machine_id_idx` covers this predicate and the id ordering below.
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

    // Built as a list rather than nested ternaries: org scope, cursor, and the
    // machine filter are independent, and `and()` ignores the undefined gaps.
    const conditions = [
      eq(events.orgId, params.orgId),
      params.cursor ? lt(events.id, params.cursor) : undefined,
      params.machineId ? eq(events.machineId, params.machineId) : undefined,
    ];

    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(events)
          .where(and(...conditions))
          .orderBy(desc(events.id))
          .limit(limit + 1),
      catch: (cause) => new EvidenceQueryError({ reason: "events_query_failed", cause }),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const data = page.map((row) => projectEvent(row));

    return {
      data,
      pageInfo: {
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        hasMore,
      },
    } satisfies EvidencePage;
  });
