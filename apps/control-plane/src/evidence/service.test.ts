import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type * as schema from "@cloudable/schema";
import { events, accessCommandRecorded } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import { cleanupOrgRows, connectTestDb } from "../test-support/db";
import { queryEvidencePage } from "./service";

let db: PostgresJsDatabase<typeof schema>;
let close: () => Promise<void>;

beforeAll(() => {
  const conn = connectTestDb();
  db = conn.db;
  close = conn.close;
});

afterAll(async () => {
  await close();
});

const testOrgIds: string[] = [];
const testCorrelationIds: string[] = [];
afterEach(async () => {
  while (testCorrelationIds.length > 0) {
    const correlationId = testCorrelationIds.pop();
    if (correlationId)
      await db
        .delete(accessCommandRecorded)
        .where(eq(accessCommandRecorded.correlationId, correlationId));
  }
  while (testOrgIds.length > 0) {
    const orgId = testOrgIds.pop();
    if (orgId) await cleanupOrgRows(db, orgId);
  }
});

const freshOrgId = () => {
  const id = crypto.randomUUID();
  testOrgIds.push(id);
  return id;
};

// Inserted directly against the raw `events` table — this test exercises
// the read side (`queryEvidencePage`), not `EventBus.publish`'s tier
// filtering (covered in `../services/EventBus.test.ts`).
const insertRawEvent = (orgId: string, id: string, correlationId: string) =>
  db.insert(events).values({
    id,
    type: "machine.started",
    occurredAt: new Date(),
    orgId,
    actorType: "person",
    actorId: "person-1",
    machineId: null,
    correlationId,
    schemaVersion: 1,
    payload: {},
  });

describe("queryEvidencePage (spec §18)", () => {
  test("projects raw events newest-first without mutating the source table", async () => {
    const orgId = freshOrgId();
    // ULIDs sort lexically by creation time — these three are deliberately
    // in increasing order so "newest first" has an unambiguous expectation.
    await insertRawEvent(orgId, "01J0000000000000000000AAA", "corr-a");
    await insertRawEvent(orgId, "01J0000000000000000000BBB", "corr-b");
    await insertRawEvent(orgId, "01J0000000000000000000CCC", "corr-c");

    const before = await db.select().from(events).where(eq(events.orgId, orgId));

    const page = await Effect.runPromise(queryEvidencePage(db, { orgId }));

    expect(page.data.map((r) => r.id)).toEqual([
      "01J0000000000000000000CCC",
      "01J0000000000000000000BBB",
      "01J0000000000000000000AAA",
    ]);
    expect(page.pageInfo.hasMore).toBe(false);
    expect(page.pageInfo.nextCursor).toBeNull();

    const after = await db.select().from(events).where(eq(events.orgId, orgId));
    expect(after).toEqual(before); // read-only: the raw table is untouched
  });

  test("cursor-paginates across pages", async () => {
    const orgId = freshOrgId();
    await insertRawEvent(orgId, "01J0000000000000000001AAA", "corr-a");
    await insertRawEvent(orgId, "01J0000000000000000001BBB", "corr-b");
    await insertRawEvent(orgId, "01J0000000000000000001CCC", "corr-c");

    const page1 = await Effect.runPromise(queryEvidencePage(db, { orgId, limit: 2 }));
    expect(page1.data.map((r) => r.id)).toEqual([
      "01J0000000000000000001CCC",
      "01J0000000000000000001BBB",
    ]);
    expect(page1.pageInfo.hasMore).toBe(true);
    expect(page1.pageInfo.nextCursor).toBe("01J0000000000000000001BBB");

    const page2 = await Effect.runPromise(
      queryEvidencePage(db, { orgId, limit: 2, cursor: page1.pageInfo.nextCursor ?? undefined }),
    );
    expect(page2.data.map((r) => r.id)).toEqual(["01J0000000000000000001AAA"]);
    expect(page2.pageInfo.hasMore).toBe(false);
    expect(page2.pageInfo.nextCursor).toBeNull();
  });

  test("references access_command_recorded by correlationId without merging it into the row", async () => {
    const orgId = freshOrgId();
    const correlationId = crypto.randomUUID();
    testCorrelationIds.push(correlationId);
    await insertRawEvent(orgId, "01J0000000000000000002AAA", correlationId);

    await db.insert(accessCommandRecorded).values([
      {
        id: crypto.randomUUID(),
        machineId: crypto.randomUUID(),
        osUser: "ubuntu",
        command: "ls -la",
        occurredAt: new Date(),
        correlationId,
      },
      {
        id: crypto.randomUUID(),
        machineId: crypto.randomUUID(),
        osUser: "ubuntu",
        command: "whoami",
        occurredAt: new Date(),
        correlationId,
      },
    ]);

    const page = await Effect.runPromise(queryEvidencePage(db, { orgId }));
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.commandRecording).toEqual({ correlationId, count: 2 });
  });

  test("scopes strictly to the requested org", async () => {
    const orgA = freshOrgId();
    const orgB = freshOrgId();
    await insertRawEvent(orgA, "01J0000000000000000003AAA", "corr-a");
    await insertRawEvent(orgB, "01J0000000000000000003BBB", "corr-b");

    const page = await Effect.runPromise(queryEvidencePage(db, { orgId: orgA }));
    expect(page.data.map((r) => r.orgId)).toEqual([orgA]);
  });
});
