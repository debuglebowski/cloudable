// Runs against the docker-compose Postgres (already migrated) rather than a fresh
// testcontainers instance — same reasoning as `ApprovalService.test.ts`'s
// `expireOverdueApprovals` test: every row here is scoped by a fresh random `orgId`, so
// there's no isolation need that justifies a second container. `ElevationService.test.ts`
// itself mocks `ElevationRepoTag` in-memory (see that file's own comment on why a real
// Postgres testcontainer hangs under Bun in this sandbox) — `expireOverdueElevations` reads
// `Db` directly, bypassing that repo port entirely (same as its siblings
// `expireOverdueApprovals`/`expireOverdueSnapshots`), so it belongs in its own real-DB suite
// rather than that file's mocked one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as schema from "@cloudable/schema";
import { events, elevations } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { expireOverdueElevations } from "./ElevationService";

describe("expireOverdueElevations", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<Db>;

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    TestLayer = Layer.succeed(Db, db);
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = () => Effect.runPromise(Effect.provide(expireOverdueElevations, TestLayer));

  const insertElevation = (overrides: {
    status: "requested" | "granted" | "expired" | "denied";
    expiresAt: Date | null;
    orgId?: string;
    machineId?: string;
  }) =>
    db
      .insert(elevations)
      .values({
        orgId: overrides.orgId ?? crypto.randomUUID(),
        personId: crypto.randomUUID(),
        machineId: overrides.machineId ?? crypto.randomUUID(),
        level: "shell",
        reason: "expiry sweep test",
        approvalId: null,
        grantedAt: overrides.status === "granted" ? new Date(Date.now() - 3600_000) : null,
        expiresAt: overrides.expiresAt,
        status: overrides.status,
      })
      .returning();

  test("flips a granted-but-overdue elevation to expired and emits access.elevation_expired", async () => {
    const orgId = crypto.randomUUID();
    const machineId = crypto.randomUUID();
    const past = new Date(Date.now() - 1_000);
    const [row] = await insertElevation({ status: "granted", expiresAt: past, orgId, machineId });
    if (!row) throw new Error("insert returned no row");

    const count = await run();
    expect(count).toBeGreaterThanOrEqual(1);

    const [updated] = await db.select().from(elevations).where(eq(elevations.id, row.id));
    expect(updated?.status).toBe("expired");

    const emitted = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, orgId), eq(events.type, "access.elevation_expired")));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.actorType).toBe("system");
    expect(emitted[0]?.machineId).toBe(machineId);
    expect(emitted[0]?.correlationId).toBe(row.id);
  });

  test("leaves a granted elevation that hasn't expired yet untouched", async () => {
    const future = new Date(Date.now() + 3600_000);
    const [row] = await insertElevation({ status: "granted", expiresAt: future });
    if (!row) throw new Error("insert returned no row");

    await run();

    const [unchanged] = await db.select().from(elevations).where(eq(elevations.id, row.id));
    expect(unchanged?.status).toBe("granted");
  });

  test("never touches a requested, expired, or denied elevation, even with a past expiresAt", async () => {
    const past = new Date(Date.now() - 1_000);
    const [requested] = await insertElevation({ status: "requested", expiresAt: null });
    const [alreadyExpired] = await insertElevation({ status: "expired", expiresAt: past });
    const [denied] = await insertElevation({ status: "denied", expiresAt: null });
    if (!requested || !alreadyExpired || !denied) throw new Error("insert returned no row");

    await run();

    const rows = await db
      .select()
      .from(elevations)
      .where(and(eq(elevations.id, requested.id), eq(elevations.status, "requested")));
    expect(rows).toHaveLength(1);

    const [stillDenied] = await db.select().from(elevations).where(eq(elevations.id, denied.id));
    expect(stillDenied?.status).toBe("denied");
  });
});
