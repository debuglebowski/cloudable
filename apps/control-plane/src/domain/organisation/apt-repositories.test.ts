import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APT_REPOSITORIES_POLL_KEY } from "@cloudable/contracts";
import * as schema from "@cloudable/schema";
import { events, aptRepositories, machines, orgs, settingValues } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { Effect, Layer } from "effect";
import postgres from "postgres";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { ApprovalService, settingKeyFor } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import { isDbReachable } from "../../testing/db-reachable";
import { pollSettingsFor } from "../vulnerability-scan/poll-settings";
import {
  applyApprovedAptRepositoryChange,
  recordReportedAptState,
  requestAptRepositoryAdd,
  requestAptRepositoryRemove,
  undeclaredAptSources,
} from "./apt-repositories";

const KEY = readFileSync(join(import.meta.dir, "__fixtures__/nodesource-repo.asc"), "utf8");
const FINGERPRINT = "6F71F525282841EEDAF851B42F59B5F99B1BE0B4";
const NODESOURCE = {
  name: "NodeSource",
  url: "https://deb.nodesource.com/node_24.x",
  suite: "nodistro",
  components: ["main"],
  signingKey: KEY,
  reason: "Node 24 for Claude Code",
};

describe("undeclaredAptSources", () => {
  const approved = [{ id: "11111111-1111-1111-1111-111111111111", url: NODESOURCE.url }];
  test("Ubuntu's own and approved repositories are explained; anything else is not", () => {
    expect(
      undeclaredAptSources(
        [
          {
            file: "/etc/apt/sources.list.d/ubuntu.sources",
            uri: "http://azure.archive.ubuntu.com/ubuntu/",
          },
          {
            file: "/etc/apt/sources.list.d/ubuntu.sources",
            uri: "http://security.ubuntu.com/ubuntu",
          },
          {
            file: "/etc/apt/sources.list.d/cloudable-11111111-1111-1111-1111-111111111111.sources",
            uri: `${NODESOURCE.url}/`,
          },
          {
            file: "/etc/apt/sources.list.d/docker.list",
            uri: "https://download.docker.com/linux/ubuntu",
          },
          {
            file: "/etc/apt/sources.list.d/microsoft-prod.list",
            uri: "https://packages.microsoft.com/ubuntu/24.04/prod",
          },
        ],
        approved,
        { malwareProtection: false },
      ),
    ).toEqual([
      "https://download.docker.com/linux/ubuntu",
      "https://packages.microsoft.com/ubuntu/24.04/prod",
    ]);
  });

  test("the approved URL in someone else's file is still undeclared; Microsoft's feed is fine with Defender on", () => {
    expect(
      undeclaredAptSources(
        [
          { file: "/etc/apt/sources.list.d/nodesource.list", uri: NODESOURCE.url },
          {
            file: "/etc/apt/sources.list.d/microsoft-prod.list",
            uri: "https://packages.microsoft.com/ubuntu/24.04/prod",
          },
        ],
        approved,
        { malwareProtection: true },
      ),
    ).toEqual([NODESOURCE.url]);
  });
});

const reachable = await isDbReachable(config.databaseUrl);

describe.skipIf(!reachable)("apt repositories (requires Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;
  type Env = Db | EventBus | ApprovalService;
  let layer: Layer.Layer<Env>;
  const requester = crypto.randomUUID();
  const approver = crypto.randomUUID();

  beforeAll(() => {
    sql = postgres(config.databaseUrl);
    db = drizzle(sql, { schema });
    const dbLayer = Layer.succeed(Db, db);
    layer = Layer.mergeAll(
      EventBus.Default.pipe(Layer.provide(dbLayer)),
      ApprovalService.Default,
      dbLayer,
    ).pipe(Layer.provide(dbLayer));
  });
  afterAll(async () => {
    await sql.end();
  });

  const run = <A, E>(effect: Effect.Effect<A, E, Env>) =>
    Effect.runPromise(Effect.provide(effect, layer));
  const fail = <A, E>(effect: Effect.Effect<A, E, Env>) =>
    Effect.runPromise(Effect.provide(Effect.flip(effect), layer));

  async function seedOrg(mode?: "none" | "single") {
    const [org] = await db
      .insert(orgs)
      .values({ name: `org-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("seed failed");
    if (mode) {
      await db.insert(settingValues).values({
        scopeType: "org",
        scopeId: org.id,
        key: settingKeyFor("apt_repository"),
        value: mode,
        source: "org",
      });
    }
    return org;
  }

  async function seedMachine(orgId: string) {
    const [machine] = await db
      .insert(machines)
      .values({
        orgId,
        name: "m1",
        provider: "fake",
        sizeSku: "s",
        image: "ubuntu-24.04",
        state: "running",
      })
      .returning();
    if (!machine) throw new Error("seed failed");
    return machine;
  }

  const typesFor = async (orgId: string) =>
    (await db.select().from(events).where(eq(events.orgId, orgId))).map((e) => e.type);

  test("adding waits for its approval, then writes the row, records it and reaches the poll", async () => {
    const org = await seedOrg();
    const machine = await seedMachine(org.id);

    const asked = await run(
      requestAptRepositoryAdd({ orgId: org.id, personId: requester, ...NODESOURCE }),
    );
    expect(asked).toMatchObject({ status: "pending", fingerprint: FINGERPRINT });
    expect(
      await db.select().from(aptRepositories).where(eq(aptRepositories.orgId, org.id)),
    ).toEqual([]);

    await run(
      Effect.gen(function* () {
        const approvals = yield* ApprovalService;
        const decided = yield* approvals.decide(
          asked.approvalId,
          org.id,
          approver,
          "approved",
          "ok",
        );
        yield* applyApprovedAptRepositoryChange(decided);
      }),
    );
    const [row] = await db.select().from(aptRepositories).where(eq(aptRepositories.orgId, org.id));
    expect(row).toMatchObject({ name: "NodeSource", fingerprint: FINGERPRINT, removedAt: null });
    expect(await typesFor(org.id)).toContain("org.apt_repository_added");

    const [after] = await db.select().from(machines).where(eq(machines.id, machine.id));
    expect(after?.desiredStateVersion).toBeGreaterThan(machine.desiredStateVersion);

    const settings = await Effect.runPromise(pollSettingsFor(db, org.id, null));
    expect(settings[APT_REPOSITORIES_POLL_KEY]).toEqual([
      {
        id: row?.id,
        url: NODESOURCE.url,
        suite: "nodistro",
        components: ["main"],
        signingKey: expect.stringContaining("BEGIN PGP PUBLIC KEY BLOCK"),
        fingerprint: FINGERPRINT,
      },
    ]);
  });

  test("with the mode at none it applies at once; removing keeps the record", async () => {
    const org = await seedOrg("none");
    const asked = await run(
      requestAptRepositoryAdd({ orgId: org.id, personId: requester, ...NODESOURCE }),
    );
    expect(asked.status).toBe("approved");
    const [row] = await db.select().from(aptRepositories).where(eq(aptRepositories.orgId, org.id));
    if (!row) throw new Error("not added");

    const removed = await run(
      requestAptRepositoryRemove({
        orgId: org.id,
        personId: requester,
        repositoryId: row.id,
        reason: "done",
      }),
    );
    expect(removed.status).toBe("approved");
    const [kept] = await db.select().from(aptRepositories).where(eq(aptRepositories.id, row.id));
    expect(kept?.removedAt).not.toBeNull();
    expect(await typesFor(org.id)).toContain("org.apt_repository_removed");
    const settings = await Effect.runPromise(pollSettingsFor(db, org.id, null));
    expect(settings[APT_REPOSITORIES_POLL_KEY]).toBeUndefined();
  });

  test("a bad URL, key or missing reason is refused before anyone is asked", async () => {
    const org = await seedOrg();
    const http = await fail(
      requestAptRepositoryAdd({
        orgId: org.id,
        personId: requester,
        ...NODESOURCE,
        url: "http://x",
      }),
    );
    expect(http).toMatchObject({ code: "invalid_apt_repository" });
    const key = await fail(
      requestAptRepositoryAdd({
        orgId: org.id,
        personId: requester,
        ...NODESOURCE,
        signingKey: "nope",
      }),
    );
    expect(key).toMatchObject({ code: "invalid_apt_repository" });
    const reason = await fail(
      requestAptRepositoryAdd({ orgId: org.id, personId: requester, ...NODESOURCE, reason: " " }),
    );
    expect(reason).toMatchObject({ code: "reason_required" });
    expect(await typesFor(org.id)).not.toContain("approval.requested");
  });

  test("a report records repositories put in place, and unexplained sources as drift until they go", async () => {
    const org = await seedOrg("none");
    const machine = await seedMachine(org.id);
    await run(requestAptRepositoryAdd({ orgId: org.id, personId: requester, ...NODESOURCE }));
    const [repo] = await db.select().from(aptRepositories).where(eq(aptRepositories.orgId, org.id));
    if (!repo) throw new Error("not added");
    const report = (extra: { file: string; uri: string }[]) =>
      run(
        recordReportedAptState(db, {
          orgId: org.id,
          machineId: machine.id,
          aptRepositoryIds: [repo.id],
          aptSources: [
            {
              file: "/etc/apt/sources.list.d/ubuntu.sources",
              uri: "http://archive.ubuntu.com/ubuntu",
            },
            { file: `/etc/apt/sources.list.d/cloudable-${repo.id}.sources`, uri: NODESOURCE.url },
            ...extra,
          ],
        }),
      );

    await report([
      { file: "/etc/apt/sources.list.d/sketchy.list", uri: "https://example.com/apt" },
    ]);
    await report([
      { file: "/etc/apt/sources.list.d/sketchy.list", uri: "https://example.com/apt" },
    ]);
    await report([]);

    const machineEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.orgId, org.id), eq(events.machineId, machine.id)));
    const byType = (type: string) => machineEvents.filter((e) => e.type === type);
    expect(byType("machine.apt_repository_configured")).toHaveLength(1);
    // Once for the new source, not again for the repeat report, then resolved once.
    expect(byType("machine.drift_detected").map((e) => e.payload)).toEqual([
      {
        undeclaredPackages: [],
        undeclaredPorts: [],
        undeclaredAptSources: ["https://example.com/apt"],
      },
    ]);
    expect(byType("machine.drift_resolved").map((e) => e.payload)).toEqual([
      { removed: [], approvalId: null, removedAptSources: ["https://example.com/apt"] },
    ]);
    const [stored] = await db.select().from(machines).where(eq(machines.id, machine.id));
    expect(stored?.undeclaredAptSources).toEqual([]);
  });
});
