import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { providerCatalogEntries } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../db/layer";
import { connectAndMigrate } from "../test-support/db";
import {
  isGen2Capable,
  isOfferedArchitecture,
  isScheduledForRetirement,
  upsertEntries,
} from "./CloudCatalogService";

describe("isGen2Capable", () => {
  test("accepts a size whose HyperVGenerations includes V2", () => {
    expect(isGen2Capable({ capabilities: [{ name: "HyperVGenerations", value: "V1,V2" }] })).toBe(
      true,
    );
    expect(isGen2Capable({ capabilities: [{ name: "HyperVGenerations", value: "V2" }] })).toBe(
      true,
    );
  });

  test("rejects a size stuck on V1 — seen live: Standard_A4m_v2 failed VM creation against this deployment's (Gen2-only) images with exactly this mismatch", () => {
    expect(isGen2Capable({ capabilities: [{ name: "HyperVGenerations", value: "V1" }] })).toBe(
      false,
    );
  });

  test("treats a missing HyperVGenerations capability as not Gen2-capable, not as unknown", () => {
    expect(isGen2Capable({ capabilities: [] })).toBe(false);
    expect(isGen2Capable({})).toBe(false);
  });
});

describe("isScheduledForRetirement", () => {
  test("flags a size Azure has announced it will retire, regardless of the actual date", () => {
    expect(
      isScheduledForRetirement({
        capabilities: [{ name: "RetirementDateUtc", value: "11/16/2028" }],
      }),
    ).toBe(true);
  });

  test("a size with no RetirementDateUtc capability is not flagged", () => {
    expect(isScheduledForRetirement({ capabilities: [{ name: "vCPUs", value: "4" }] })).toBe(false);
    expect(isScheduledForRetirement({ capabilities: [] })).toBe(false);
    expect(isScheduledForRetirement({})).toBe(false);
  });
});

describe("isOfferedArchitecture", () => {
  test("x64 is offered -- both UBUNTU_IMAGES entries require it", () => {
    expect(isOfferedArchitecture("x64")).toBe(true);
  });

  test("an architecture no current image requires (e.g. Arm64) is not offered", () => {
    expect(isOfferedArchitecture("Arm64")).toBe(false);
  });

  test("a missing CpuArchitectureType capability is not offered, not unknown", () => {
    expect(isOfferedArchitecture(undefined)).toBe(false);
  });
});

// Real Postgres, not a fake — same convention/skip-guard as
// `../config/config.test.ts` and `../domain/machine/MachineService.test.ts`.
// This specific regression is a schema/column-type bug (memoryGb declared
// `integer` when real Azure data — e.g. Standard_B1ls's "0.5" GB — is
// sometimes fractional), which only a real insert against the real column
// type can catch; a pure-function test of the parsing logic alone would
// have passed either way and did not catch this the first time.
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";

function isReachable(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

const { hostname, port } = new URL(databaseUrl);
const postgresReachable = await isReachable(hostname, Number(port) || 5432, 2000);

describe.skipIf(!postgresReachable)("upsertEntries (requires Postgres at DATABASE_URL)", () => {
  let close: () => Promise<void>;
  let db: Awaited<ReturnType<typeof connectAndMigrate>>["db"];
  const testCode = "__test_fractional_memory_sku__";

  beforeAll(async () => {
    const conn = await connectAndMigrate(databaseUrl);
    db = conn.db;
    close = conn.close;
  });

  afterAll(async () => {
    if (!close) return;
    await db.delete(providerCatalogEntries).where(eq(providerCatalogEntries.code, testCode));
    await close();
  });

  test("a fractional memoryGb (real Azure data, e.g. Standard_B1ls's 0.5 GB) round-trips without throwing", async () => {
    await Effect.runPromise(
      upsertEntries("azure", "sku", [
        { code: testCode, displayName: "test (0.5 GB RAM)", vcpus: 1, memoryGb: 0.5 },
      ]).pipe(Effect.provideService(Db, db)),
    );

    const [row] = await db
      .select({ memoryGb: providerCatalogEntries.memoryGb })
      .from(providerCatalogEntries)
      .where(eq(providerCatalogEntries.code, testCode));
    expect(row?.memoryGb).toBe(0.5);
  });
});
