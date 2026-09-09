import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { providerCatalogEntries } from "@cloudable/schema";
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../db/layer";
import { connectAndMigrate } from "../test-support/db";
import type { CatalogKind } from "./CloudCatalogService";
import {
  isGen2Capable,
  isOfferedArchitecture,
  isRestrictedInLocation,
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

describe("isRestrictedInLocation", () => {
  // Real data: `az vm list-skus --location northeurope --size Standard_B4as_v2 --all`
  // against the production subscription, seen live after a user hit
  // `quota_exceeded: ... currently not available in location 'northeurope'`
  // creating a machine with this exact SKU.
  const b4asRestrictions = [
    {
      type: "Location",
      values: ["northeurope"],
      reasonCode: "NotAvailableForSubscription",
    },
    {
      type: "Zone",
      values: ["northeurope"],
      reasonCode: "NotAvailableForSubscription",
    },
  ];

  test("flags a SKU with a Location restriction covering the deployment's region", () => {
    expect(isRestrictedInLocation({ restrictions: b4asRestrictions }, "northeurope")).toBe(true);
  });

  test("does not flag a Location restriction for a different region", () => {
    expect(isRestrictedInLocation({ restrictions: b4asRestrictions }, "westeurope")).toBe(false);
  });

  // Deliberate: this deployment never pins an availability zone, so a SKU restricted
  // in only some zones can still be placed in whichever zone isn't restricted — see
  // isRestrictedInLocation's own doc comment.
  test("does not flag a Zone-only restriction, even for the deployment's own region", () => {
    expect(
      isRestrictedInLocation(
        { restrictions: [{ type: "Zone", values: ["northeurope"] }] },
        "northeurope",
      ),
    ).toBe(false);
  });

  test("a SKU with no restrictions at all is not flagged", () => {
    expect(isRestrictedInLocation({ restrictions: [] }, "northeurope")).toBe(false);
    expect(isRestrictedInLocation({}, "northeurope")).toBe(false);
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

  // `upsertEntries` now prunes anything for the (provider, kind) it's called with that
  // isn't in the entries it was just given (see its own doc comment) — correct for its
  // three real callers, which always pass the complete current set for that kind, but a
  // real hazard for a test calling it directly with a small fixture list: this dev box's
  // shared Postgres (this file's own "Real Postgres, not a fake" comment above) can hold
  // 1000+ real synced `sku` rows at the same DATABASE_URL these tests run against, and a
  // fixture list that doesn't include them all would prune every one of them. Each test
  // below gets its OWN fake `kind` (never one of the real "region"/"image"/"sku", and
  // never shared between tests) so a prune can only ever affect that one test's own
  // rows — regardless of execution order, and safe even if these ever ran concurrently.
  // `as CatalogKind` is a test-only escape hatch past the production type, which
  // deliberately only allows the real three.

  beforeAll(async () => {
    const conn = await connectAndMigrate(databaseUrl);
    db = conn.db;
    close = conn.close;
  });

  afterAll(async () => {
    if (!close) return;
    await db
      .delete(providerCatalogEntries)
      .where(
        inArray(providerCatalogEntries.kind, [
          "__test_kind_fractional__",
          "__test_kind_prune__",
          "__test_kind_prune_empty__",
        ] as unknown as CatalogKind[]),
      );
    await close();
  });

  test("a fractional memoryGb (real Azure data, e.g. Standard_B1ls's 0.5 GB) round-trips without throwing", async () => {
    const kind = "__test_kind_fractional__" as CatalogKind;
    const code = "__test_fractional_memory_sku__";
    await Effect.runPromise(
      upsertEntries("azure", kind, [
        { code, displayName: "test (0.5 GB RAM)", vcpus: 1, memoryGb: 0.5 },
      ]).pipe(Effect.provideService(Db, db)),
    );

    const [row] = await db
      .select({ memoryGb: providerCatalogEntries.memoryGb })
      .from(providerCatalogEntries)
      .where(eq(providerCatalogEntries.code, code));
    expect(row?.memoryGb).toBe(0.5);
  });

  // The regression this guards: a size that stops matching a sync's filters (retired,
  // architecture no longer offered, or just synced under an older, less-strict version
  // of this filter) used to keep its row forever — null vcpus/memoryGb/architecture,
  // but still fully selectable in the Add Machine wizard. Confirmed live against a real
  // subscription: 1434 stored sku rows, only 1056 actually returned by a real sync.
  test("a subsequent sync prunes a code the new sync no longer returns", async () => {
    const kind = "__test_kind_prune__" as CatalogKind;
    const kept = "__test_prune_kept__";
    const stale = "__test_prune_stale__";
    await Effect.runPromise(
      upsertEntries("azure", kind, [
        { code: kept, displayName: "kept", vcpus: 2, memoryGb: 4, architecture: "x64" },
        { code: stale, displayName: "stale", vcpus: 2, memoryGb: 4, architecture: "x64" },
      ]).pipe(Effect.provideService(Db, db)),
    );

    await Effect.runPromise(
      upsertEntries("azure", kind, [
        { code: kept, displayName: "kept", vcpus: 2, memoryGb: 4, architecture: "x64" },
      ]).pipe(Effect.provideService(Db, db)),
    );

    const rows = await db
      .select({ code: providerCatalogEntries.code })
      .from(providerCatalogEntries)
      .where(eq(providerCatalogEntries.kind, kind));
    expect(rows.map((row) => row.code)).toEqual([kept]);
  });

  // Guards the empty-result safeguard: a transient Azure/auth hiccup returning zero
  // rows should never be read as "this kind is genuinely empty now" and wipe it.
  test("an empty sync result leaves existing rows untouched rather than wiping the kind", async () => {
    const kind = "__test_kind_prune_empty__" as CatalogKind;
    const code = "__test_prune_untouched__";
    await Effect.runPromise(
      upsertEntries("azure", kind, [
        { code, displayName: "untouched", vcpus: 1, memoryGb: 1 },
      ]).pipe(Effect.provideService(Db, db)),
    );

    await Effect.runPromise(upsertEntries("azure", kind, []).pipe(Effect.provideService(Db, db)));

    const [row] = await db
      .select({ code: providerCatalogEntries.code })
      .from(providerCatalogEntries)
      .where(eq(providerCatalogEntries.code, code));
    expect(row?.code).toBe(code);
  });
});
