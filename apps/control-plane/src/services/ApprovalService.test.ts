import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { events, approvals, settingValues } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../config";
import { Db } from "../db/layer";
import {
  type ApprovalActionType,
  ApprovalError,
  ApprovalService,
  expireOverdueApprovals,
} from "./ApprovalService";

// Runs against the docker-compose Postgres (already migrated — see
// CLAUDE.md's E2E verification section) rather than spinning up a fresh
// `test/testcontainers.ts` container: this suite doesn't need an isolated
// database (every test scopes its rows by a fresh random `orgId`), and
// reusing the already-running instance avoids contending with other
// concurrently-running testcontainers for Docker resources.
describe("ApprovalService", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<ApprovalService | Db>;

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    // `provideMerge` (rather than `provide`) so `Db` stays in the layer's
    // output too — the `expireOverdueApprovals` test below calls it directly
    // and needs `Db` in scope, not just hidden behind `ApprovalService`.
    TestLayer = ApprovalService.Default.pipe(Layer.provideMerge(Layer.succeed(Db, db)));
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, ApprovalService | Db>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  const runFail = <A, E>(effect: Effect.Effect<A, E, ApprovalService | Db>) =>
    Effect.runPromise(Effect.provide(Effect.flip(effect), TestLayer));

  const setApprovalMode = (
    orgId: string,
    actionType: ApprovalActionType,
    mode: "none" | "single" | "dual",
  ) =>
    db.insert(settingValues).values({
      scopeType: "org",
      scopeId: orgId,
      key: `approval_mode:${actionType}`,
      value: mode,
      source: "org",
    });

  const eventsFor = (orgId: string, type?: string) =>
    db
      .select()
      .from(events)
      .where(type ? and(eq(events.orgId, orgId), eq(events.type, type)) : eq(events.orgId, orgId));

  test("mode 'none': still creates a record and emits requested -> granted, since even auto-approval is evidence", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    await setApprovalMode(orgId, "offboarding", "none");

    const result = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId,
          actionType: "offboarding",
          requestedByPersonId: personId,
          targetMachineId: null,
          reason: "leaving the company",
        });
      }),
    );

    expect(result.status).toBe("approved");
    expect(result.requiredApprovals).toBe(0);
    expect(result.decidedAt).not.toBeNull();

    const emitted = await eventsFor(orgId);
    expect(emitted.map((e) => e.type).sort()).toEqual(["approval.granted", "approval.requested"]);
    const granted = emitted.find((e) => e.type === "approval.granted");
    expect(granted?.actorType).toBe("system");
    expect(granted?.payload).toMatchObject({ approverIds: [], actionType: "offboarding" });
  });

  test("requestAutoApproved: ElevationService's 'always'-policy bypass produces the byte-identical row/event shape as mode 'none' — and ignores the org's configured approval_mode", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const machineId = crypto.randomUUID();
    // Configured strictly ("dual") — `requestAutoApproved` must still skip
    // straight to approved, since it never resolves mode from settings at
    // all (unlike `request`, which would stay "pending" against this mode).
    await setApprovalMode(orgId, "admin_access", "dual");

    const result = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.requestAutoApproved({
          orgId,
          actionType: "admin_access",
          requestedByPersonId: personId,
          targetMachineId: machineId,
          reason: "org policy is admin_access_policy: always",
        });
      }),
    );

    expect(result.status).toBe("approved");
    expect(result.mode).toBe("none");
    expect(result.requiredApprovals).toBe(0);
    expect(result.decidedAt).not.toBeNull();

    const emitted = await eventsFor(orgId);
    expect(emitted.map((e) => e.type).sort()).toEqual(["approval.granted", "approval.requested"]);
    const requested = emitted.find((e) => e.type === "approval.requested");
    const granted = emitted.find((e) => e.type === "approval.granted");
    // Same correlationId ties the pair together, same as the mode-"none" path.
    expect(requested?.correlationId).toBe(granted?.correlationId);
    expect(granted?.actorType).toBe("system");
    expect(granted?.payload).toMatchObject({ approverIds: [], actionType: "admin_access" });
  });

  test("mode 'single' (default policy): pending until one approval, then granted", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const approverId = crypto.randomUUID();

    const requested = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId,
          actionType: "admin_access",
          requestedByPersonId: personId,
          targetMachineId: null,
          reason: "need to recover files",
        });
      }),
    );
    expect(requested.status).toBe("pending");
    expect(requested.mode).toBe("single");
    expect(requested.requiredApprovals).toBe(1);

    const decided = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.decide(requested.id, orgId, approverId, "approved");
      }),
    );
    expect(decided.status).toBe("approved");
    expect(decided.approvedCount).toBe(1);

    const emitted = await eventsFor(orgId, "approval.granted");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({
      approverIds: [approverId],
      actionType: "admin_access",
    });
  });

  test("mode 'dual': requires two distinct approvers before granting", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const approverA = crypto.randomUUID();
    const approverB = crypto.randomUUID();
    await setApprovalMode(orgId, "break_glass", "dual");

    const requested = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId,
          actionType: "break_glass",
          requestedByPersonId: personId,
          targetMachineId: null,
          reason: "production incident",
        });
      }),
    );
    expect(requested.requiredApprovals).toBe(2);

    const afterFirst = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.decide(requested.id, orgId, approverA, "approved");
      }),
    );
    expect(afterFirst.status).toBe("pending");
    expect(afterFirst.approvedCount).toBe(1);

    const afterSecond = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.decide(requested.id, orgId, approverB, "approved");
      }),
    );
    expect(afterSecond.status).toBe("approved");
    expect(afterSecond.approvedCount).toBe(2);

    const emitted = await eventsFor(orgId, "approval.granted");
    expect(emitted).toHaveLength(1);
    expect((emitted[0]?.payload as { approverIds: string[] }).approverIds.sort()).toEqual(
      [approverA, approverB].sort(),
    );
  });

  test("requiredModeFloor clamps a weaker configured mode UP — 'none' configured, 'dual' required, resolves to 'dual'", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    await setApprovalMode(orgId, "snapshot_restore", "none");

    const requested = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId,
          actionType: "snapshot_restore",
          requestedByPersonId: personId,
          targetMachineId: null,
          reason: "full restore under a none-mode org policy",
          requiredModeFloor: "dual",
        });
      }),
    );

    // The regression this closes: without the floor, "none" configured would mean
    // `requiredApprovals: 0` and instant auto-approval — zero human review.
    expect(requested.mode).toBe("dual");
    expect(requested.requiredApprovals).toBe(2);
    expect(requested.status).toBe("pending");
  });

  test("requiredModeFloor never lowers a configured mode that already satisfies it", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    await setApprovalMode(orgId, "snapshot_restore", "dual");

    const requested = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId,
          actionType: "snapshot_restore",
          requestedByPersonId: personId,
          targetMachineId: null,
          reason: "config restore under an already-dual org policy",
          requiredModeFloor: "single",
        });
      }),
    );

    expect(requested.mode).toBe("dual");
    expect(requested.requiredApprovals).toBe(2);
  });

  test("omitting requiredModeFloor leaves the org's configured mode untouched, including 'none'", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    await setApprovalMode(orgId, "snapshot_restore", "none");

    const requested = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId,
          actionType: "snapshot_restore",
          requestedByPersonId: personId,
          targetMachineId: null,
          reason: "data restore, no floor",
        });
      }),
    );

    expect(requested.mode).toBe("none");
    expect(requested.status).toBe("approved");
  });

  test("a rejection requires a reason, and once given is recorded as evidence on approval.denied", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const approverId = crypto.randomUUID();

    const requested = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId,
          actionType: "snapshot_restore",
          requestedByPersonId: personId,
          targetMachineId: null,
          reason: "restore prod snapshot",
        });
      }),
    );

    const missingReasonError = await runFail(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.decide(requested.id, orgId, approverId, "rejected");
      }),
    );
    expect(missingReasonError).toBeInstanceOf(ApprovalError);
    expect((missingReasonError as ApprovalError).reason).toBe("reason_required");

    // The failed attempt above must not have recorded anything.
    const stillPending = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.status(requested.id, orgId);
      }),
    );
    expect(stillPending.status).toBe("pending");

    const denied = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.decide(
          requested.id,
          orgId,
          approverId,
          "rejected",
          "fails change review",
        );
      }),
    );
    expect(denied.status).toBe("rejected");

    const emitted = await eventsFor(orgId, "approval.denied");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({
      approverIds: [approverId],
      actionType: "snapshot_restore",
      reason: "fails change review",
    });
  });

  test("rejects a duplicate decision from the same person on the same approval", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const approverId = crypto.randomUUID();
    await setApprovalMode(orgId, "break_glass", "dual");

    const requested = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId,
          actionType: "break_glass",
          requestedByPersonId: personId,
          targetMachineId: null,
          reason: "incident",
        });
      }),
    );

    await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.decide(requested.id, orgId, approverId, "approved");
      }),
    );

    const error = await runFail(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.decide(requested.id, orgId, approverId, "approved");
      }),
    );
    expect((error as ApprovalError).reason).toBe("duplicate_decision");
  });

  test("rejects deciding on an approval that is no longer pending", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    await setApprovalMode(orgId, "offboarding", "none");

    const requested = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId,
          actionType: "offboarding",
          requestedByPersonId: personId,
          targetMachineId: null,
          reason: "leaving",
        });
      }),
    );
    expect(requested.status).toBe("approved");

    const error = await runFail(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.decide(requested.id, orgId, crypto.randomUUID(), "approved");
      }),
    );
    expect((error as ApprovalError).reason).toBe("already_decided");
  });

  test("status and decide fail with not_found for an unknown approval id", async () => {
    const statusError = await runFail(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.status(crypto.randomUUID(), crypto.randomUUID());
      }),
    );
    expect((statusError as ApprovalError).reason).toBe("not_found");

    const decideError = await runFail(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.decide(
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          "approved",
        );
      }),
    );
    expect((decideError as ApprovalError).reason).toBe("not_found");
  });

  test("status and decide return not_found for an approval that belongs to a DIFFERENT org — the actual tenant-isolation fix, not just an unknown id", async () => {
    const orgId = crypto.randomUUID();
    const otherOrgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    await setApprovalMode(orgId, "admin_access", "single");

    const requested = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId,
          actionType: "admin_access",
          requestedByPersonId: personId,
          targetMachineId: null,
          reason: "need to recover files",
        });
      }),
    );

    const statusError = await runFail(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.status(requested.id, otherOrgId);
      }),
    );
    expect((statusError as ApprovalError).reason).toBe("not_found");

    const decideError = await runFail(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.decide(requested.id, otherOrgId, crypto.randomUUID(), "approved");
      }),
    );
    expect((decideError as ApprovalError).reason).toBe("not_found");

    // Still genuinely pending in its real org — the wrong-org calls above
    // didn't leak into deciding it either.
    const stillPending = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.status(requested.id, orgId);
      }),
    );
    expect(stillPending.status).toBe("pending");
  });

  test("an empty or missing reason on request is rejected", async () => {
    const error = await runFail(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.request({
          orgId: crypto.randomUUID(),
          actionType: "admin_access",
          requestedByPersonId: crypto.randomUUID(),
          targetMachineId: null,
          reason: "   ",
        });
      }),
    );
    expect((error as ApprovalError).reason).toBe("reason_required");
  });

  test("list filters by orgId and status, and paginates with a cursor", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    await setApprovalMode(orgId, "admin_access", "single");

    for (let i = 0; i < 3; i++) {
      await run(
        Effect.gen(function* () {
          const service = yield* ApprovalService;
          return yield* service.request({
            orgId,
            actionType: "admin_access",
            requestedByPersonId: personId,
            targetMachineId: null,
            reason: `request ${i}`,
          });
        }),
      );
    }

    const page1 = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.list({ orgId, limit: 2 });
      }),
    );
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.list({ orgId, limit: 2, cursor: page1.nextCursor ?? undefined });
      }),
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.hasMore).toBe(false);

    const allIds = new Set([...page1.items, ...page2.items].map((i) => i.id));
    expect(allIds.size).toBe(3);

    const pendingOnly = await run(
      Effect.gen(function* () {
        const service = yield* ApprovalService;
        return yield* service.list({ orgId, status: "pending" });
      }),
    );
    expect(pendingOnly.items).toHaveLength(3);
    expect(pendingOnly.items.every((i) => i.status === "pending")).toBe(true);
  });

  test("expireOverdueApprovals flips pending-but-expired approvals to expired and emits approval.expired", async () => {
    const orgId = crypto.randomUUID();
    const personId = crypto.randomUUID();
    const past = new Date(Date.now() - 1_000);

    const [row] = await db
      .insert(approvals)
      .values({
        orgId,
        actionType: "admin_access",
        mode: "single",
        status: "pending",
        requestedByPersonId: personId,
        targetMachineId: null,
        reason: "expiring soon",
        requiredApprovals: 1,
        expiresAt: past,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");

    const count = await Effect.runPromise(Effect.provide(expireOverdueApprovals, TestLayer));
    expect(count).toBeGreaterThanOrEqual(1);

    const [updated] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(updated?.status).toBe("expired");

    const emitted = await eventsFor(orgId, "approval.expired");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.actorType).toBe("system");
  });
});
