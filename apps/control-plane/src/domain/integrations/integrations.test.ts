import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { orgs } from "@cloudable/schema";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { isDbReachable } from "../../testing/db-reachable";
import { connectIntegration, disconnectIntegration, listActiveIntegrations } from "./integrations";

// Real Postgres, not a fake — the behaviour under test is
// `disconnectIntegration`'s own cross-tenant scoping (the `orgId` check
// folded into its `where`), which only matters against the real
// `integrations` table.
const databaseUrl = config.databaseUrl;
const dbReachable = await isDbReachable(databaseUrl);

describe.skipIf(!dbReachable)("integrations — tenant isolation (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  let TestLayer: Layer.Layer<Db>;

  beforeAll(() => {
    sql = postgres(databaseUrl);
    db = drizzle(sql, { schema });
    TestLayer = Layer.succeed(Db, db);
  });

  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Db>) =>
    Effect.runPromise(Effect.provide(effect, TestLayer));

  async function seedOrg() {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    return org;
  }

  test("disconnectIntegration with the wrong orgId leaves another org's integration connected", async () => {
    const org = await seedOrg();
    const otherOrg = await seedOrg();

    const integration = await run(
      connectIntegration({
        orgId: org.id,
        kind: "idp",
        identifier: "okta",
        config: { provider: "okta", metadataUrl: "https://example.okta.com/metadata" },
      }),
    );

    // Wrong org's call succeeds (no error — matches an UPDATE affecting zero
    // rows, see `disconnectIntegration`'s own doc comment) but must not
    // actually remove the real integration.
    await run(disconnectIntegration(integration.id, otherOrg.id));

    const stillActive = await run(listActiveIntegrations(org.id));
    expect(stillActive.find((i) => i.id === integration.id)).toBeDefined();
  });

  test("disconnectIntegration with the correct orgId actually removes it", async () => {
    const org = await seedOrg();

    const integration = await run(
      connectIntegration({
        orgId: org.id,
        kind: "cloud",
        identifier: "azure",
        config: { tenantId: "t1", applicationId: "a1", subscriptionId: "s1" },
      }),
    );

    await run(disconnectIntegration(integration.id, org.id));

    const stillActive = await run(listActiveIntegrations(org.id));
    expect(stillActive.find((i) => i.id === integration.id)).toBeUndefined();
  });

  test("listActiveIntegrations never returns another org's rows", async () => {
    const org = await seedOrg();
    const otherOrg = await seedOrg();
    await run(
      connectIntegration({
        orgId: org.id,
        kind: "secret_store",
        identifier: "vault",
        config: { provider: "azure_key_vault", vaultUrl: "https://example.vault.azure.net" },
      }),
    );
    await run(
      connectIntegration({
        orgId: otherOrg.id,
        kind: "secret_store",
        identifier: "vault-other",
        config: { provider: "azure_key_vault", vaultUrl: "https://other.vault.azure.net" },
      }),
    );

    const rows = await run(listActiveIntegrations(org.id));
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.orgId === org.id)).toBe(true);
  });
});
