import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@cloudable/schema";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Db } from "../src/db/layer";
import { MachineService } from "../src/domain/machine/MachineService";
import { Api } from "../src/http/api";
import { AgentProtocolLive } from "../src/http/handlers/agent-protocol";
import { ApprovalsLive } from "../src/http/handlers/approvals";
import { ComplianceLive } from "../src/http/handlers/compliance";
import { HealthLive } from "../src/http/handlers/health";
import { MachinesLive } from "../src/http/handlers/machines";
import { EvidenceLive } from "../src/evidence/handler";
import { ApprovalService } from "../src/services/ApprovalService";
import { EventBus } from "../src/services/EventBus";
import { AgentSessionToken } from "../src/services/attestation/AgentSessionToken";
import { AttestationRegistryTag } from "../src/services/attestation/AttestationMethod";
import { joinTokenAttestation } from "../src/services/attestation/JoinTokenAttestation";
import { MachineDirectory } from "../src/services/attestation/MachineDirectory";
import { startTestDb } from "./testcontainers";

/**
 * Exercises the real `POST /attest`/`GET /poll`/`POST /report` handlers end
 * to end against a throwaway Postgres (via testcontainers), through
 * `HttpApiBuilder.toWebHandler` — an in-process `Request -> Response`
 * function, so this needs no bound TCP port. The registry is seeded with
 * only the real `joinTokenAttestation` (managed-identity needs a live JWKS
 * endpoint, out of scope for this check) and `AgentSessionToken.Default` is
 * the real implementation; nothing here is faked except which Postgres
 * instance `Db` points at.
 *
 * Lives under `test/` (not `src/`, like `testcontainers.ts` itself — see
 * that file's own comment) and is NOT named `*.test.ts`, so it isn't picked
 * up by plain `bun test` (this unit's `test:unit` script) or `tsc -b`
 * (`apps/control-plane/tsconfig.json`'s `rootDir` is `src`). Both exclusions
 * are deliberate: `testcontainers-node`'s `.start()` hangs indefinitely
 * under Bun in this repo's stack (upstream: oven-sh/bun#21342,
 * testcontainers-node#974 — the container starts fine at the Docker level,
 * the JS promise just never resolves), so a discoverable `.test.ts` file
 * here would make every `test:unit` run hang. This unit's actual E2E
 * verification was done directly against `docker compose`'s Postgres (see
 * `docs/agents.md` / this unit's PR description), which doesn't go through
 * `testcontainers-node` and is unaffected.
 *
 * Keep this file as documentation of the intended coverage, and re-enable
 * it (rename to `*.test.ts`, wire a `test:integration` script to it) once
 * the upstream bug is fixed. Until then, run it manually only if you've
 * confirmed `testcontainers-node` doesn't hang in your environment:
 * `bun test test/agent-protocol.integration-check.ts` from `apps/control-plane`.
 */
describe("agent-protocol handlers (integration)", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let handler: (request: Request) => Promise<Response>;
  let dispose: () => Promise<void>;
  let orgId: string;
  let machineId: string;

  beforeAll(async () => {
    testDb = await startTestDb();

    const [org] = await testDb.db.insert(schema.orgs).values({ name: "test-org" }).returning();
    if (!org) throw new Error("failed to insert test org");
    orgId = org.id;

    const [machine] = await testDb.db
      .insert(schema.machines)
      .values({ orgId, name: "test-machine", region: "local", sizeSku: "dev", image: "dev" })
      .returning();
    if (!machine) throw new Error("failed to insert test machine");
    machineId = machine.id;

    const ApiLive = HttpApiBuilder.api(Api).pipe(
      Layer.provide(
        Layer.mergeAll(
          HealthLive,
          AgentProtocolLive,
          MachinesLive,
          ApprovalsLive,
          ComplianceLive,
          EvidenceLive,
        ),
      ),
    );
    const AttestationRegistryLive = Layer.succeed(
      AttestationRegistryTag,
      new Map([[joinTokenAttestation.method, joinTokenAttestation]]),
    );
    const AppLayer = Layer.mergeAll(
      EventBus.Default,
      MachineDirectory.Default,
      AgentSessionToken.Default,
      MachineService.Default,
      ApprovalService.Default,
      AttestationRegistryLive,
    ).pipe(Layer.provide(Layer.succeed(Db, testDb.db)));

    const built = HttpApiBuilder.toWebHandler(
      Layer.mergeAll(ApiLive, HttpServer.layerContext).pipe(
        Layer.provide(AppLayer),
        // EvidenceLive (folded into ApiLive above) needs Db directly, same
        // as the real server.ts — AppLayer's Db provision is internal to
        // its own construction and isn't exposed outward.
        Layer.provide(Layer.succeed(Db, testDb.db)),
      ),
    );
    handler = built.handler;
    dispose = built.dispose;
  });

  afterAll(async () => {
    await dispose();
    await testDb.stop();
  });

  const eventsOfType = async (type: string) =>
    testDb.db.select().from(schema.events).where(eq(schema.events.type, type));

  test("POST /attest with a garbage credential is rejected (401) and emits agent.attestation_failed", async () => {
    const before = (await eventsOfType("agent.attestation_failed")).length;

    const res = await handler(
      new Request("http://localhost/api/v1/agent/attest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "join_token", credential: "this-is-not-a-real-token" }),
      }),
    );

    expect(res.status).toBe(401);

    const failures = await eventsOfType("agent.attestation_failed");
    expect(failures.length).toBe(before + 1);
    const latest = failures[failures.length - 1];
    expect(latest?.actorType).toBe("agent");
    expect((latest?.payload as { reason?: string }).reason).toBe("malformed_credential");
  });

  test("POST /attest with a valid join token succeeds and emits agent.attested", async () => {
    const credential = await Effect.runPromise(joinTokenAttestation.issueCredential({ orgId, machineId }));

    const res = await handler(
      new Request("http://localhost/api/v1/agent/attest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "join_token", credential }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { bearerToken: string; orgId: string; machineId: string };
    expect(body.orgId).toBe(orgId);
    expect(body.machineId).toBe(machineId);
    expect(typeof body.bearerToken).toBe("string");

    const attested = await eventsOfType("agent.attested");
    expect(attested.length).toBeGreaterThan(0);
  });

  test("GET /poll requires a bearer token", async () => {
    const res = await handler(new Request("http://localhost/api/v1/agent/poll"));
    expect(res.status).toBe(401);
  });

  test("GET /poll returns 200 with an ETag, then 304 when it's replayed", async () => {
    const credential = await Effect.runPromise(joinTokenAttestation.issueCredential({ orgId, machineId }));
    const attestRes = await handler(
      new Request("http://localhost/api/v1/agent/attest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "join_token", credential }),
      }),
    );
    const { bearerToken } = (await attestRes.json()) as { bearerToken: string };

    const first = await handler(
      new Request("http://localhost/api/v1/agent/poll", {
        headers: { authorization: `Bearer ${bearerToken}` },
      }),
    );
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await handler(
      new Request("http://localhost/api/v1/agent/poll", {
        headers: { authorization: `Bearer ${bearerToken}`, "if-none-match": etag ?? "" },
      }),
    );
    expect(second.status).toBe(304);
  });

  test("POST /report updates last_verified_at and emits machine.first_seen on first report", async () => {
    const credential = await Effect.runPromise(joinTokenAttestation.issueCredential({ orgId, machineId }));
    const attestRes = await handler(
      new Request("http://localhost/api/v1/agent/attest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "join_token", credential }),
      }),
    );
    const { bearerToken } = (await attestRes.json()) as { bearerToken: string };

    const reportRes = await handler(
      new Request("http://localhost/api/v1/agent/report", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` },
        body: JSON.stringify({
          agentVersion: "0.0.0",
          observedAt: new Date().toISOString(),
          installedPackages: [],
          openPorts: [],
        }),
      }),
    );
    expect(reportRes.status).toBe(200);

    const [row] = await testDb.db
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, machineId));
    expect(row?.lastVerifiedAt).not.toBeNull();

    const firstSeen = await eventsOfType("machine.first_seen");
    expect(firstSeen.length).toBeGreaterThan(0);
  });
});
