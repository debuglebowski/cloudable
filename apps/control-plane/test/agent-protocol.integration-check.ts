import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { VULNERABILITY_SCAN_SETTING_KEYS } from "@cloudable/contracts";
import * as schema from "@cloudable/schema";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { AppConfigLive } from "../src/config";
import { Db } from "../src/db/layer";
import { ElevationRepoLive } from "../src/domain/elevation/ElevationRepo.live";
import { ElevationService } from "../src/domain/elevation/ElevationService";
import { MachineService } from "../src/domain/machine/MachineService";
import { OffboardingLive } from "../src/domain/offboarding";
import { EvidenceLive } from "../src/evidence/handler";
import { Api } from "../src/http/api";
import { AccessLive } from "../src/http/handlers/access";
import { AgentProtocolLive } from "../src/http/handlers/agent-protocol";
import { ApprovalsLive } from "../src/http/handlers/approvals";
import { ArchiveLive } from "../src/http/handlers/archive";
import { AuthSsoStatusLive } from "../src/http/handlers/auth-sso-status";
import { CatalogLive } from "../src/http/handlers/catalog";
import { CliAuthLive } from "../src/http/handlers/cli-auth";
import { ComplianceLive } from "../src/http/handlers/compliance";
import { ConfigLive } from "../src/http/handlers/config";
import { ElevationsLive } from "../src/http/handlers/elevations";
import { HealthLive } from "../src/http/handlers/health";
import { IntegrationsLive } from "../src/http/handlers/integrations";
import { MachinesLive } from "../src/http/handlers/machines";
import { NotificationsLive } from "../src/http/handlers/notifications";
import { OffboardingHttpLive } from "../src/http/handlers/offboarding";
import { OrganisationLive } from "../src/http/handlers/organisation";
import { PeopleLive } from "../src/http/handlers/people";
import { ProvisioningCapabilitiesLive } from "../src/http/handlers/provisioning-capabilities";
import { RestartLive } from "../src/http/handlers/restart";
import { TunnelLive } from "../src/http/handlers/tunnel";
import { TunnelSignalLive } from "../src/http/handlers/tunnel-signal";
import { UpgradeLive } from "../src/http/handlers/upgrade";
import { VulnerabilityScanLive } from "../src/http/handlers/vulnerability-scan";
import { CurrentUserAuthenticationLive } from "../src/http/middleware/auth";
import { ApprovalService } from "../src/services/ApprovalService";
import { EventBus } from "../src/services/EventBus";
import { FakeProvisioningServiceLive } from "../src/services/ProvisioningService.fake";
import { LocalSignerLive } from "../src/services/Signer.local";
import { AgentSessionToken } from "../src/services/attestation/AgentSessionToken";
import { AttestationRegistryTag } from "../src/services/attestation/AttestationMethod";
import { joinTokenAttestation } from "../src/services/attestation/JoinTokenAttestation";
import { MachineDirectory } from "../src/services/attestation/MachineDirectory";
import { SshCaService } from "../src/services/ssh-ca/SshCaService";
import { TunnelRegistry } from "../src/tunnel/registry";
import { TunnelRelay } from "../src/tunnel/relay";
import { TunnelServer } from "../src/tunnel/server";
import { TunnelSignal } from "../src/tunnel/signal";
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
      .values({ orgId, name: "test-machine", provider: "fake", sizeSku: "dev", image: "dev" })
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
          ArchiveLive,
          OffboardingHttpLive,
          UpgradeLive,
          ElevationsLive,
          ConfigLive,
          AccessLive,
          PeopleLive,
          OrganisationLive,
          IntegrationsLive,
          TunnelSignalLive,
          TunnelLive,
          NotificationsLive,
          RestartLive,
          CatalogLive,
          ProvisioningCapabilitiesLive,
          AuthSsoStatusLive,
          CliAuthLive,
          VulnerabilityScanLive,
        ),
      ),
    );
    const AttestationRegistryLive = Layer.succeed(
      AttestationRegistryTag,
      new Map([[joinTokenAttestation.method, joinTokenAttestation]]),
    );
    // Same wiring as `layers.ts`: `TunnelRelay` composes `TunnelServer` (below) with
    // `TunnelRegistry` — built once so `OffboardingLive` and `ArchiveLive` (folded into
    // `ApiLive` above) share the same registry instance.
    const tunnelServerForRelay = TunnelServer.Default.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventBus.Default,
          LocalSignerLive,
          Layer.succeed(Db, testDb.db),
          TunnelSignal.Default,
        ),
      ),
    );
    const tunnelRelay = TunnelRelay.Default.pipe(
      Layer.provideMerge(Layer.mergeAll(tunnelServerForRelay, TunnelRegistry.Default)),
    );
    const AppLayer = Layer.mergeAll(
      EventBus.Default,
      MachineDirectory.Default,
      AgentSessionToken.Default,
      // Same wiring as `layers.ts`: MachineService.create now calls
      // ProvisioningServiceTag directly, so it needs it provided explicitly.
      MachineService.Default.pipe(Layer.provide(FakeProvisioningServiceLive)),
      ApprovalService.Default,
      AttestationRegistryLive,
      FakeProvisioningServiceLive,
      CurrentUserAuthenticationLive,
      tunnelRelay,
      OffboardingLive.pipe(Layer.provide(FakeProvisioningServiceLive), Layer.provide(tunnelRelay)),
      // Same wiring as `layers.ts`'s `buildAppLive`: `ElevationService`
      // needs EventBus/ApprovalService/its own repo provided explicitly —
      // `Layer.mergeAll` is a flat union, not a dependency graph.
      ElevationService.Default.pipe(
        Layer.provide(EventBus.Default),
        Layer.provide(ApprovalService.Default),
        Layer.provide(ElevationRepoLive),
      ),
      // Same wiring as `layers.ts`: SshCaService/TunnelServer read
      // Signer/EventBus/Db lazily when their methods are called, not only
      // during construction, so `provideMerge` (not `provide`) is needed to
      // keep those services present in the final ambient context.
      SshCaService.Default.pipe(
        Layer.provideMerge(
          Layer.mergeAll(EventBus.Default, LocalSignerLive, Layer.succeed(Db, testDb.db)),
        ),
      ),
      // Same instance `tunnelRelay` above is built from — not a second, separately
      // constructed `TunnelServer` — exposed standalone so `TunnelSignalLive` (folded into
      // `ApiLive` above) can depend on `TunnelServer`/`TunnelSignal` directly.
      tunnelServerForRelay,
      TunnelSignal.Default,
    ).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Db, testDb.db), AppConfigLive)));

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
    // Bun's default hook timeout is 5s, and this hook starts a real Postgres
    // testcontainer: about a second locally with the image cached, longer
    // than 5s on a cold CI runner that has to pull it first. It has timed out
    // on two unrelated commits, each time reading as a code regression rather
    // than a container pull. 120s is far more than it ever needs and still
    // fails fast if the daemon is genuinely wedged.
  }, 120_000);

  afterAll(async () => {
    await dispose();
    await testDb.stop();
  }, 60_000);

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
    const credential = await Effect.runPromise(
      joinTokenAttestation.issueCredential({ orgId, machineId }),
    );

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
    const credential = await Effect.runPromise(
      joinTokenAttestation.issueCredential({ orgId, machineId }),
    );
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
    const credential = await Effect.runPromise(
      joinTokenAttestation.issueCredential({ orgId, machineId }),
    );
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
          configState: { runningAccessMethods: [] },
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
  describe("vulnerability scanning", () => {
    const KEYS = VULNERABILITY_SCAN_SETTING_KEYS;

    const attest = async (): Promise<string> => {
      const credential = await Effect.runPromise(
        joinTokenAttestation.issueCredential({ orgId, machineId }),
      );
      const res = await handler(
        new Request("http://localhost/api/v1/agent/attest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: "join_token", credential }),
        }),
      );
      return ((await res.json()) as { bearerToken: string }).bearerToken;
    };

    const poll = (bearerToken: string, etag?: string) =>
      handler(
        new Request("http://localhost/api/v1/agent/poll", {
          headers: {
            authorization: `Bearer ${bearerToken}`,
            ...(etag ? { "if-none-match": etag } : {}),
          },
        }),
      );

    const report = (bearerToken: string, extra: Record<string, unknown>) =>
      handler(
        new Request("http://localhost/api/v1/agent/report", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` },
          body: JSON.stringify({
            agentVersion: "0.0.0",
            observedAt: new Date().toISOString(),
            installedPackages: [],
            openPorts: [],
            configState: { runningAccessMethods: [] },
            ...extra,
          }),
        }),
      );

    const scanReport = (overrides: Record<string, unknown> = {}) => ({
      scanId: crypto.randomUUID(),
      scanner: "trivy",
      scannerVersion: "0.75.0",
      scope: "os",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      finishedAt: new Date(Date.now() - 60_000).toISOString(),
      outcome: "completed",
      dbBuiltAt: new Date(Date.now() - 3_600_000).toISOString(),
      findings: [
        {
          vulnerabilityId: "CVE-2026-0001",
          ecosystem: "os",
          packageName: "openssl",
          installedVersion: "3.0.2",
          fixedVersion: "3.0.3",
          severity: "critical",
        },
      ],
      ...overrides,
    });

    test("scanning off: the poll carries no settings; turning it on changes the ETag and adds the config", async () => {
      const token = await attest();
      const before = await poll(token);
      expect(before.status).toBe(200);
      expect(((await before.json()) as { settings: object }).settings).toEqual({});
      const etagBefore = before.headers.get("etag") ?? "";

      // What `applySettingChange` does for these keys (covered by its own tests): write the row
      // and move the machine's desired-state version.
      await testDb.db.insert(schema.settingValues).values({
        scopeType: "org",
        scopeId: orgId,
        key: KEYS.enabled,
        value: true,
        source: "org",
      });
      await testDb.db
        .update(schema.machines)
        .set({ desiredStateVersion: sql`${schema.machines.desiredStateVersion} + 1` })
        .where(eq(schema.machines.id, machineId));

      const unchanged = await poll(token, etagBefore);
      expect(unchanged.status).toBe(200);
      expect(unchanged.headers.get("etag")).not.toBe(etagBefore);
      const body = (await unchanged.json()) as {
        settings: { vulnerabilityScan?: { scanner: string; scanDays: string[]; release: unknown } };
      };
      expect(body.settings.vulnerabilityScan?.scanner).toBe("trivy");
      expect(body.settings.vulnerabilityScan?.scanDays).toEqual(["sun"]);
      // This test image carries no scanner, and the poll says so rather than inventing one.
      expect(body.settings.vulnerabilityScan?.release).toBeNull();

      await testDb.db.delete(schema.settingValues).where(eq(schema.settingValues.scopeId, orgId));
    });

    test("a reported scan is stored, its findings kept, and exactly one event written", async () => {
      const token = await attest();
      const scan = scanReport();
      const res = await report(token, { vulnerabilityScan: scan });
      expect(res.status).toBe(200);

      const events = (await eventsOfType("machine.vulnerability_scan_completed")).filter(
        (event) => event.correlationId === scan.scanId,
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.actorType).toBe("agent");
      expect(events[0]?.machineId).toBe(machineId);

      const findings = await testDb.db
        .select()
        .from(schema.machineVulnerabilities)
        .where(eq(schema.machineVulnerabilities.machineId, machineId));
      expect(findings.map((f) => f.vulnerabilityId)).toContain("CVE-2026-0001");
    });

    test("the same scan sent again is acknowledged and changes nothing", async () => {
      const token = await attest();
      const scan = scanReport({
        findings: [
          {
            vulnerabilityId: "CVE-2026-0002",
            ecosystem: "os",
            packageName: "zlib",
            installedVersion: "1.2.11",
            fixedVersion: null,
            severity: "high",
          },
        ],
      });
      expect((await report(token, { vulnerabilityScan: scan })).status).toBe(200);
      expect((await report(token, { vulnerabilityScan: scan })).status).toBe(200);

      const events = (await eventsOfType("machine.vulnerability_scan_completed")).filter(
        (event) => event.correlationId === scan.scanId,
      );
      expect(events).toHaveLength(1);
    });

    test("a failed scan is recorded with its reason", async () => {
      const token = await attest();
      const scan = scanReport({
        outcome: "failed",
        failureReason: "db_unavailable",
        findings: undefined,
        dbBuiltAt: undefined,
      });
      expect((await report(token, { vulnerabilityScan: scan })).status).toBe(200);
      const failed = (await eventsOfType("machine.vulnerability_scan_failed")).filter(
        (event) => event.correlationId === scan.scanId,
      );
      expect(failed).toHaveLength(1);
      expect((failed[0]?.payload as { reason: string }).reason).toBe("db_unavailable");
    });

    test("a report whose scan is malformed is refused and stores nothing", async () => {
      const token = await attest();
      const scan = scanReport({
        findings: [
          {
            vulnerabilityId: "CVE-2026-0003",
            ecosystem: "os",
            packageName: "curl",
            installedVersion: "7.0",
            fixedVersion: null,
            severity: "catastrophic",
          },
        ],
      });
      const res = await report(token, { vulnerabilityScan: scan });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const rows = await testDb.db
        .select()
        .from(schema.machineVulnerabilityScans)
        .where(eq(schema.machineVulnerabilityScans.scanId, scan.scanId));
      expect(rows).toHaveLength(0);
    });

    test("the scanner a machine reports is recorded once, as machine.scanner_installed", async () => {
      const token = await attest();
      const before = (await eventsOfType("machine.scanner_installed")).length;
      expect((await report(token, { scanner: { name: "trivy", version: "0.75.0" } })).status).toBe(
        200,
      );
      expect((await report(token, { scanner: { name: "trivy", version: "0.75.0" } })).status).toBe(
        200,
      );

      const installed = await eventsOfType("machine.scanner_installed");
      expect(installed.length).toBe(before + 1);
      expect(installed[installed.length - 1]?.payload).toEqual({
        scanner: "trivy",
        version: "0.75.0",
        previousVersion: null,
      });
    });
  });
});
