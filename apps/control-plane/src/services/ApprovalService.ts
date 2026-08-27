import type { DomainEvent } from "@cloudable/events";
import {
  events,
  type SettingRow,
  approvalDecisions,
  approvals,
  resolveSetting,
  settingValues,
} from "@cloudable/schema";
import { type SQL, and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { type Context, Data, Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../db/layer";
import { toEventRows } from "./EventBus";

export type ApprovalActionType =
  | "snapshot_restore"
  | "break_glass"
  | "admin_access"
  | "offboarding";
export type ApprovalMode = "none" | "single" | "dual";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalDecisionValue = "approved" | "rejected";

export interface ApprovalRequest {
  orgId: string;
  actionType: ApprovalActionType;
  requestedByPersonId: string;
  targetMachineId: string | null;
  reason: string;
}

export interface ApprovalResult {
  id: string;
  orgId: string;
  actionType: ApprovalActionType;
  mode: ApprovalMode;
  status: ApprovalStatus;
  requestedByPersonId: string;
  targetMachineId: string | null;
  reason: string;
  requiredApprovals: number;
  /** Count of distinct people who have recorded an "approved" decision so far. */
  approvedCount: number;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
}

export class ApprovalError extends Data.TaggedError("ApprovalError")<{
  reason:
    | "not_found"
    | "already_decided"
    | "duplicate_decision"
    | "reason_required"
    | "query_failed"
    | "insert_failed";
  cause?: unknown;
}> {}

type ApprovalRow = typeof approvals.$inferSelect;

// No policy configured for an action type: require at least one approval —
// the safe default for actions this object exists to gate.
const DEFAULT_APPROVAL_MODE: ApprovalMode = "single";

const REQUIRED_APPROVALS_BY_MODE: Record<ApprovalMode, number> = {
  none: 0,
  single: 1,
  dual: 2,
};

// Approval requests are time-boxed — an undecided request doesn't linger
// forever (see `expireOverdueApprovals`).
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// `resolveSetting`'s chain requires a `machineId`; org-scoped actions (no
// target machine) pass this nil id so they can never accidentally match a
// real machine-scoped override.
const NIL_MACHINE_ID = "00000000-0000-0000-0000-000000000000";

// `actorId` is NOT NULL on the events table — this is the well-known sentinel
// for `actorType: "system"` (spec §24: "actor_id: null when actor_type is
// system" describes the conceptual model; this table's column is non-null,
// so a system actor is still identified, just by this fixed id rather than null).
const SYSTEM_ACTOR_ID = "system";

const settingKeyFor = (actionType: ApprovalActionType) => `approval_mode:${actionType}`;

const resolveApprovalMode = (
  db: Context.Tag.Service<typeof Db>,
  orgId: string,
  targetMachineId: string | null,
  actionType: ApprovalActionType,
): Effect.Effect<ApprovalMode, ApprovalError> =>
  Effect.gen(function* () {
    const key = settingKeyFor(actionType);
    const rows = yield* Effect.tryPromise({
      try: () => db.select().from(settingValues).where(eq(settingValues.key, key)),
      catch: (cause) => new ApprovalError({ reason: "query_failed", cause }),
    });

    // Template layer doesn't exist in v1 — chain is org -> machine only.
    const settingRows: SettingRow<ApprovalMode>[] = rows
      .filter((row) => row.scopeType !== "template")
      .map((row) => ({
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        key: row.key,
        value: row.value as ApprovalMode,
        source: row.source,
      }));

    const resolved = resolveSetting(key, settingRows, {
      orgId,
      templateId: null,
      machineId: targetMachineId ?? NIL_MACHINE_ID,
    });

    return resolved?.value ?? DEFAULT_APPROVAL_MODE;
  });

const toResult = (row: ApprovalRow, approvedCount: number): ApprovalResult => ({
  id: row.id,
  orgId: row.orgId,
  actionType: row.actionType,
  mode: row.mode,
  status: row.status,
  requestedByPersonId: row.requestedByPersonId,
  targetMachineId: row.targetMachineId,
  reason: row.reason,
  requiredApprovals: row.requiredApprovals,
  approvedCount,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  decidedAt: row.decidedAt,
});

const baseEnvelope = (
  row: Pick<ApprovalRow, "orgId" | "targetMachineId">,
  actorType: "person" | "system",
  actorId: string,
  correlationId: string,
) => ({
  // Overwritten by `toEventRows` (see EventBus.ts), which assigns the real
  // ULID/recordedAt at write time — placeholders here only satisfy the
  // envelope's shape.
  id: "",
  recordedAt: new Date(),
  occurredAt: new Date(),
  orgId: row.orgId,
  actorType,
  actorId,
  machineId: row.targetMachineId,
  correlationId,
  schemaVersion: 1,
});

export interface ListApprovalsParams {
  orgId?: string | undefined;
  status?: ApprovalStatus | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface ListApprovalsResult {
  items: ApprovalResult[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface Cursor {
  createdAt: Date;
  id: string;
}

const encodeCursor = (row: Pick<ApprovalRow, "createdAt" | "id">): string =>
  Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string): Cursor | null => {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
};

/**
 * The generic approval object (spec §13): single/dual-control gate for
 * sensitive actions (snapshot restore, break-glass, admin access,
 * offboarding). Approval mode is policy, resolved per action type through
 * the org -> machine chain (`resolveSetting`, template inert in v1).
 *
 * Every decision writes an event, granted or denied — denials are evidence
 * and are never silently dropped. Even a "none"-mode auto-approval still
 * creates a record and emits both `approval.requested` and
 * `approval.granted`, because even auto-approval is evidence.
 */
export class ApprovalService extends Effect.Service<ApprovalService>()("ApprovalService", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    const getRow = (approvalId: string): Effect.Effect<ApprovalRow, ApprovalError> =>
      Effect.gen(function* () {
        const rows = yield* Effect.tryPromise({
          try: () => db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1),
          catch: (cause) => new ApprovalError({ reason: "query_failed", cause }),
        });
        const row = rows[0];
        if (!row) return yield* Effect.fail(new ApprovalError({ reason: "not_found" }));
        return row;
      });

    const countApproved = (approvalId: string): Effect.Effect<string[], ApprovalError> =>
      Effect.tryPromise({
        try: () =>
          db
            .select({ personId: approvalDecisions.personId })
            .from(approvalDecisions)
            .where(
              and(
                eq(approvalDecisions.approvalId, approvalId),
                eq(approvalDecisions.decision, "approved"),
              ),
            )
            .then((rows) => rows.map((r) => r.personId)),
        catch: (cause) => new ApprovalError({ reason: "query_failed", cause }),
      });

    const request = (req: ApprovalRequest): Effect.Effect<ApprovalResult, ApprovalError> =>
      Effect.gen(function* () {
        if (!req.reason.trim()) {
          return yield* Effect.fail(new ApprovalError({ reason: "reason_required" }));
        }

        const mode = yield* resolveApprovalMode(db, req.orgId, req.targetMachineId, req.actionType);
        const requiredApprovals = REQUIRED_APPROVALS_BY_MODE[mode];
        const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);

        // The state change and its event(s) are written in one transaction —
        // a request row committing with no matching `approval.requested`
        // event (or vice versa) would silently break the evidence trail.
        const { requested, granted } = yield* Effect.tryPromise({
          try: () =>
            db.transaction(async (tx) => {
              const [requested] = await tx
                .insert(approvals)
                .values({
                  orgId: req.orgId,
                  actionType: req.actionType,
                  mode,
                  status: "pending",
                  requestedByPersonId: req.requestedByPersonId,
                  targetMachineId: req.targetMachineId,
                  reason: req.reason,
                  requiredApprovals,
                  expiresAt,
                })
                .returning();
              if (!requested) throw new Error("approvals insert returned no row");

              const correlationId = ulid();
              const eventsToInsert: DomainEvent[] = [
                {
                  ...baseEnvelope(requested, "person", req.requestedByPersonId, correlationId),
                  type: "approval.requested",
                  payload: {
                    actionType: req.actionType,
                    actionRef: req.targetMachineId ?? req.requestedByPersonId,
                    reason: req.reason,
                    mode,
                  },
                },
              ];

              if (mode !== "none") {
                await tx.insert(events).values(toEventRows(eventsToInsert));
                return { requested, granted: null as ApprovalRow | null };
              }

              // "none" mode: still creates a record and emits requested ->
              // granted immediately, since even auto-approval is evidence.
              const [granted] = await tx
                .update(approvals)
                .set({ status: "approved", decidedAt: new Date() })
                .where(eq(approvals.id, requested.id))
                .returning();
              if (!granted) throw new Error("approvals update returned no row");

              eventsToInsert.push({
                ...baseEnvelope(granted, "system", SYSTEM_ACTOR_ID, correlationId),
                type: "approval.granted",
                payload: { approverIds: [], actionType: req.actionType },
              });
              await tx.insert(events).values(toEventRows(eventsToInsert));
              return { requested, granted };
            }),
          catch: (cause) => new ApprovalError({ reason: "insert_failed", cause }),
        });

        return toResult(granted ?? requested, 0);
      });

    const decide = (
      approvalId: string,
      personId: string,
      decision: ApprovalDecisionValue,
      reason?: string,
    ): Effect.Effect<ApprovalResult, ApprovalError> =>
      Effect.gen(function* () {
        const trimmedReason = reason?.trim();
        if (decision === "rejected" && !trimmedReason) {
          return yield* Effect.fail(new ApprovalError({ reason: "reason_required" }));
        }

        type Outcome =
          | { kind: "not_found" }
          | { kind: "already_decided" }
          | { kind: "duplicate_decision" }
          | { kind: "denied"; row: ApprovalRow; approverIds: string[] }
          | { kind: "granted"; row: ApprovalRow; approverIds: string[] }
          | { kind: "still_pending"; row: ApprovalRow; approverIds: string[] };

        const outcome = yield* Effect.tryPromise({
          try: (): Promise<Outcome> =>
            db.transaction(async (tx) => {
              // `FOR UPDATE` locks the row for the rest of this transaction,
              // so two concurrent `decide()` calls on the same approval
              // serialize instead of both reading "pending" and both
              // flipping status (e.g. double-granting on a single-approval
              // policy, or a duplicate `approval.granted` event).
              const [existing] = await tx
                .select()
                .from(approvals)
                .where(eq(approvals.id, approvalId))
                .for("update")
                .limit(1);
              if (!existing) return { kind: "not_found" };
              if (existing.status !== "pending") return { kind: "already_decided" };

              const [duplicate] = await tx
                .select({ id: approvalDecisions.id })
                .from(approvalDecisions)
                .where(
                  and(
                    eq(approvalDecisions.approvalId, approvalId),
                    eq(approvalDecisions.personId, personId),
                  ),
                )
                .limit(1);
              if (duplicate) return { kind: "duplicate_decision" };

              await tx.insert(approvalDecisions).values({ approvalId, personId, decision });

              if (decision === "rejected") {
                if (!trimmedReason) throw new Error("unreachable: reason already validated above");
                const [updated] = await tx
                  .update(approvals)
                  .set({ status: "rejected", decidedAt: new Date() })
                  .where(eq(approvals.id, approvalId))
                  .returning();
                if (!updated) throw new Error("approvals update returned no row");

                // Denials are evidence — always emit, never silently drop,
                // and committed atomically with the status flip above.
                await tx.insert(events).values(
                  toEventRows([
                    {
                      ...baseEnvelope(updated, "person", personId, ulid()),
                      type: "approval.denied",
                      payload: {
                        approverIds: [personId],
                        actionType: updated.actionType,
                        reason: trimmedReason,
                      },
                    },
                  ]),
                );
                return { kind: "denied", row: updated, approverIds: [personId] };
              }

              const approvedRows = await tx
                .select({ personId: approvalDecisions.personId })
                .from(approvalDecisions)
                .where(
                  and(
                    eq(approvalDecisions.approvalId, approvalId),
                    eq(approvalDecisions.decision, "approved"),
                  ),
                );
              const approverIds = approvedRows.map((r) => r.personId);

              if (approverIds.length >= existing.requiredApprovals) {
                const [updated] = await tx
                  .update(approvals)
                  .set({ status: "approved", decidedAt: new Date() })
                  .where(eq(approvals.id, approvalId))
                  .returning();
                if (!updated) throw new Error("approvals update returned no row");

                await tx.insert(events).values(
                  toEventRows([
                    {
                      ...baseEnvelope(updated, "person", personId, ulid()),
                      type: "approval.granted",
                      payload: { approverIds, actionType: updated.actionType },
                    },
                  ]),
                );
                return { kind: "granted", row: updated, approverIds };
              }

              return { kind: "still_pending", row: existing, approverIds };
            }),
          catch: (cause) => new ApprovalError({ reason: "query_failed", cause }),
        });

        if (outcome.kind === "not_found") {
          return yield* Effect.fail(new ApprovalError({ reason: "not_found" }));
        }
        if (outcome.kind === "already_decided") {
          return yield* Effect.fail(new ApprovalError({ reason: "already_decided" }));
        }
        if (outcome.kind === "duplicate_decision") {
          return yield* Effect.fail(new ApprovalError({ reason: "duplicate_decision" }));
        }

        if (outcome.kind === "denied") {
          // The `approval.denied` event was already inserted atomically
          // with the status flip inside the transaction above.
          return toResult(outcome.row, 0);
        }

        if (outcome.kind === "granted") {
          // Likewise `approval.granted` — inserted alongside the flip.
          return toResult(outcome.row, outcome.approverIds.length);
        }

        // still_pending: a real recorded decision by an identified person,
        // just not (yet) enough to cross the required-approvals threshold.
        return toResult(outcome.row, outcome.approverIds.length);
      });

    const status = (approvalId: string): Effect.Effect<ApprovalResult, ApprovalError> =>
      Effect.gen(function* () {
        const row = yield* getRow(approvalId);
        const approverIds = yield* countApproved(approvalId);
        return toResult(row, approverIds.length);
      });

    const list = (params: ListApprovalsParams): Effect.Effect<ListApprovalsResult, ApprovalError> =>
      Effect.gen(function* () {
        const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
        const cursor = params.cursor ? decodeCursor(params.cursor) : null;

        const conditions: SQL[] = [];
        if (params.orgId) conditions.push(eq(approvals.orgId, params.orgId));
        if (params.status) conditions.push(eq(approvals.status, params.status));
        if (cursor) {
          const cursorCondition = or(
            lt(approvals.createdAt, cursor.createdAt),
            and(eq(approvals.createdAt, cursor.createdAt), lt(approvals.id, cursor.id)),
          );
          if (cursorCondition) conditions.push(cursorCondition);
        }

        const rows = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(approvals)
              .where(conditions.length > 0 ? and(...conditions) : undefined)
              .orderBy(desc(approvals.createdAt), desc(approvals.id))
              .limit(limit + 1),
          catch: (cause) => new ApprovalError({ reason: "query_failed", cause }),
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        const approvedDecisions =
          page.length === 0
            ? []
            : yield* Effect.tryPromise({
                try: () =>
                  db
                    .select({
                      approvalId: approvalDecisions.approvalId,
                      personId: approvalDecisions.personId,
                    })
                    .from(approvalDecisions)
                    .where(
                      and(
                        eq(approvalDecisions.decision, "approved"),
                        inArray(
                          approvalDecisions.approvalId,
                          page.map((row) => row.id),
                        ),
                      ),
                    ),
                catch: (cause) => new ApprovalError({ reason: "query_failed", cause }),
              });

        const approvedCountByApproval = new Map<string, number>();
        for (const decision of approvedDecisions) {
          approvedCountByApproval.set(
            decision.approvalId,
            (approvedCountByApproval.get(decision.approvalId) ?? 0) + 1,
          );
        }

        const items = page.map((row) => toResult(row, approvedCountByApproval.get(row.id) ?? 0));
        const last = page[page.length - 1];
        const nextCursor = hasMore && last ? encodeCursor(last) : null;

        return { items, nextCursor, hasMore };
      });

    return { request, decide, status, list } as const;
  }),
}) {}

/**
 * Sweeps `pending` approvals past their `expiresAt` to `expired`, emitting
 * `approval.expired` for each. A plain exported Effect rather than a service
 * method — callable from a future cron/scheduler, not wired to run
 * automatically in this unit.
 */
export const expireOverdueApprovals: Effect.Effect<number, ApprovalError, Db> = Effect.gen(
  function* () {
    const db = yield* Db;
    const now = new Date();

    // One transaction for the whole sweep: the status flips and their
    // `approval.expired` events commit together, and all events are batched
    // into a single insert rather than one round-trip per expired row.
    const overdue = yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const rows = await tx
            .update(approvals)
            .set({ status: "expired" })
            .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now)))
            .returning();

          if (rows.length > 0) {
            const eventsToInsert: DomainEvent[] = rows.map((row) => ({
              ...baseEnvelope(row, "system", SYSTEM_ACTOR_ID, ulid()),
              type: "approval.expired",
              payload: { actionType: row.actionType },
            }));
            await tx.insert(events).values(toEventRows(eventsToInsert));
          }

          return rows;
        }),
      catch: (cause) => new ApprovalError({ reason: "query_failed", cause }),
    });

    return overdue.length;
  },
);
