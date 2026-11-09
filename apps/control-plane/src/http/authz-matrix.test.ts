// ---------------------------------------------------------------------------
// Route-level authorization matrix: every endpoint of the API, called over
// HTTP through the real handlers, as four people of one org:
//
//   - owner:       a member who owns machine A (the machine every case targets)
//   - otherMember: a member who owns machine B, a different machine
//   - admin:       an admin (role "owner") who owns no machine
//   - approver:    a member with the approver flag, who owns no machine
//
// Each case lists who is allowed. Everyone else must get 403 or 404. An
// allowed call must not be refused by a role check (401, 403, 404). It may
// still fail for an ordinary reason, such as a fake provider that cannot do
// the thing; that is not what this file is about.
//
// A fresh org is seeded for every call, so one role's allowed mutation never
// changes what the next role sees.
//
// The first test fails when an endpoint is added to `http/api.ts` without a
// row here. Endpoints that take no person at all (public, or a machine's own
// token) are listed in `NOT_PERSON_AUTHENTICATED` with the reason.
//
// After the matrix: regressions for the three bypass chains in the go-live
// RBAC investigation (2026-11-05), and the approval flows that replaced them.
// ---------------------------------------------------------------------------
import { afterAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as schema from "@cloudable/schema";
import {
  events,
  approvals,
  certificates,
  elevations,
  integrations,
  machinePackageActions,
  machines,
  orgs,
  people,
  sessions,
  settingValues,
  snapshots,
} from "@cloudable/schema";
import { HttpApi, HttpApiBuilder, HttpServer } from "@effect/platform";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Layer } from "effect";
import postgres from "postgres";
import { buildAppLive } from "../layers";
import { issueCliAuthCode } from "../services/CliAuthCode";
import { issueCliToken } from "../services/CliToken";
import { FakeProvisioningServiceLive } from "../services/ProvisioningService.fake";
import { FakeSecretsProviderLive } from "../services/SecretsProvider.fake";
import { LocalSignerLive } from "../services/Signer.local";
import { isDbReachable } from "../testing/db-reachable";
import { Api } from "./api";
import { ApiLive } from "./api-live";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const postgresReachable = await isDbReachable(DATABASE_URL);

type Role = "owner" | "otherMember" | "admin" | "approver";
const ROLES: readonly Role[] = ["owner", "otherMember", "admin", "approver"];
const EVERYONE: readonly Role[] = ROLES;
const ADMIN: readonly Role[] = ["admin"];
const OWNER: readonly Role[] = ["owner"];
const OWNER_OR_ADMIN: readonly Role[] = ["owner", "admin"];
const NOBODY: readonly Role[] = [];

interface Fixture {
  orgId: string;
  people: Record<Role | "deactivated", string>;
  tokens: Record<Role | "deactivated", string>;
  machineA: string;
  machineB: string;
  snapshotA: string;
  sessionA: string;
  certificateA: string;
  /** A pending package_install approval memberA asked for, on machine A. */
  packageApprovalA: string;
  /** A granted elevation the admin holds on machine A (from before the policy pin). */
  elevationByAdmin: string;
  integrationId: string;
}

interface Case {
  /** `group.endpoint`, as named in `http/api.ts`. */
  readonly endpoint: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: (f: Fixture) => string;
  readonly body?: (f: Fixture) => unknown;
  readonly allow: readonly Role[];
  /** The allowed call reaches something this test cannot run (a real cloud API). Only the
   * refusals are checked. */
  readonly skipAllowed?: string;
}

/** Endpoints a person's credential does not reach. Listed so the coverage check can tell
 * "not person-authenticated" from "forgotten". */
const NOT_PERSON_AUTHENTICATED: Record<string, string> = {
  "health.check": "public liveness probe",
  "authSsoStatus.get": "public: the login page reads it before anyone signs in",
  "access.sessionTokenPublicKey": "public key, no secret",
  "tunnel.sessionTokenPublicKey": "public key, no secret",
  "agent-protocol.attest": "machine attestation, no person",
  "agent-protocol.poll": "machine token, bound to its own machine",
  "agent-protocol.report": "machine token, bound to its own machine",
  "tunnel-signal.next": "machine token, bound to its own machine",
  "access.issueCertificate":
    "authenticated by a CLI sign-in code, not a session: covered by its own test below",
  "archive.closeInspection":
    "bound to an inspection session the caller opened; covered by domain/archive/inspect*.test.ts",
  "archive.inspectionList": "same: inspection-session bound",
  "archive.inspectionRead": "same: inspection-session bound",
  "archive.inspectionDownload": "same: inspection-session bound",
};

const json = (value: unknown) => value;

const CASES: readonly Case[] = [
  // --- machines ---
  { endpoint: "machines.list", method: "GET", path: () => "/api/v1/machines", allow: EVERYONE },
  {
    endpoint: "machines.create",
    method: "POST",
    path: () => "/api/v1/machines",
    body: (f) => ({
      provider: "fake",
      sizeSku: "Standard_B2s",
      image: "ubuntu-24.04",
      ownerPersonId: f.people.approver,
    }),
    allow: ADMIN,
  },
  {
    endpoint: "machines.byId",
    method: "GET",
    path: (f) => `/api/v1/machines/${f.machineA}`,
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "machines.updatePackages",
    method: "PATCH",
    path: (f) => `/api/v1/machines/${f.machineA}/packages`,
    body: () => ({ upserts: [{ packageName: "jq" }] }),
    allow: ADMIN,
  },
  {
    endpoint: "machines.packages",
    method: "GET",
    path: (f) => `/api/v1/machines/${f.machineA}/packages`,
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "machines.createPackageAction",
    method: "POST",
    path: (f) => `/api/v1/machines/${f.machineA}/packages/htop/actions`,
    body: () => ({ op: "install" }),
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "machines.manifestHistory",
    method: "GET",
    path: (f) => `/api/v1/machines/${f.machineA}/manifest-history`,
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "restart.restartMachine",
    method: "POST",
    path: (f) => `/api/v1/machines/${f.machineA}/restart`,
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "upgrade.triggerUpgrade",
    method: "POST",
    path: (f) => `/api/v1/machines/${f.machineA}/upgrade`,
    body: () => ({ targetImage: "ubuntu-24.04", snapshotScope: "shallow" }),
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "vulnerability-scan.machine",
    method: "GET",
    path: (f) => `/api/v1/machines/${f.machineA}/vulnerabilities`,
    allow: OWNER_OR_ADMIN,
  },

  // --- access ---
  {
    endpoint: "access.mintSession",
    method: "POST",
    path: () => "/api/v1/access/sessions",
    body: (f) => ({ targetMachineId: f.machineA, method: "terminal" }),
    // Not even an admin: no live access to someone else's machine.
    allow: OWNER,
  },
  {
    endpoint: "access.listSessions",
    method: "GET",
    path: () => "/api/v1/access/sessions",
    allow: EVERYONE,
  },
  {
    endpoint: "access.endSession",
    method: "POST",
    path: () => "/api/v1/access/sessions/end",
    body: (f) => ({ sessionId: f.sessionA }),
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "access.listCertificates",
    method: "GET",
    path: () => "/api/v1/access/certificates",
    allow: EVERYONE,
  },
  {
    endpoint: "access.revokeCertificate",
    method: "POST",
    path: () => "/api/v1/access/certificates/revoke",
    body: (f) => ({ certificateId: f.certificateA, reason: "test" }),
    allow: OWNER_OR_ADMIN,
  },

  // --- elevations: with ADMIN_ACCESS_POLICY at its default `never`, nobody gets one ---
  {
    endpoint: "elevations.request",
    method: "POST",
    path: () => "/api/v1/elevations",
    body: (f) => ({ machineId: f.machineA, level: "shell", reason: "test" }),
    allow: NOBODY,
  },
  { endpoint: "elevations.list", method: "GET", path: () => "/api/v1/elevations", allow: EVERYONE },
  {
    endpoint: "elevations.get",
    method: "GET",
    path: (f) => `/api/v1/elevations/${f.elevationByAdmin}`,
    allow: ADMIN,
  },
  {
    endpoint: "elevations.sync",
    method: "POST",
    path: (f) => `/api/v1/elevations/${f.elevationByAdmin}/sync`,
    allow: ADMIN,
  },
  {
    endpoint: "elevations.expire",
    method: "POST",
    path: (f) => `/api/v1/elevations/${f.elevationByAdmin}/expire`,
    allow: ADMIN,
  },

  // --- approvals ---
  {
    endpoint: "approvals.create",
    method: "POST",
    path: () => "/api/v1/approvals",
    body: (f) => ({ actionType: "snapshot_restore", targetMachineId: f.machineA, reason: "test" }),
    allow: ADMIN,
  },
  {
    endpoint: "approvals.decide",
    method: "POST",
    path: (f) => `/api/v1/approvals/${f.packageApprovalA}/decide`,
    body: () => ({ decision: "approved" }),
    // Not the owner: they asked for it, and it is about their machine.
    allow: ["admin", "approver"],
  },
  {
    endpoint: "approvals.getById",
    method: "GET",
    path: (f) => `/api/v1/approvals/${f.packageApprovalA}`,
    allow: ["owner", "admin", "approver"],
  },
  { endpoint: "approvals.list", method: "GET", path: () => "/api/v1/approvals", allow: EVERYONE },

  // --- archive ---
  {
    endpoint: "archive.archiveMachine",
    method: "POST",
    path: (f) => `/api/v1/archive/machines/${f.machineA}/archive`,
    body: () => ({}),
    // An admin archives someone else's machine only by offboarding them.
    allow: OWNER,
  },
  {
    endpoint: "archive.restoreSnapshot",
    method: "POST",
    path: (f) => `/api/v1/archive/snapshots/${f.snapshotA}/restore`,
    body: (f) => ({
      mode: "data",
      target: { kind: "new_machine", ownerPersonId: f.people.owner },
      reason: "test",
    }),
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "archive.resumeRestore",
    method: "POST",
    path: (f) => `/api/v1/archive/restores/${f.packageApprovalA}/sync`,
    // memberA asked for that approval; it is not a restore, so the allowed callers get the
    // ordinary "not a restore approval" answer, which is a 404 of the archive domain's own.
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "archive.setLegalHold",
    method: "POST",
    path: (f) => `/api/v1/archive/snapshots/${f.snapshotA}/legal-hold`,
    body: () => ({ reason: "test" }),
    allow: ADMIN,
  },
  {
    endpoint: "archive.clearLegalHold",
    method: "POST",
    path: (f) => `/api/v1/archive/snapshots/${f.snapshotA}/legal-hold/clear`,
    body: () => ({ reason: "test" }),
    allow: ADMIN,
  },
  {
    endpoint: "archive.listSnapshots",
    method: "GET",
    path: () => "/api/v1/archive/snapshots",
    allow: EVERYONE,
  },
  {
    endpoint: "archive.getSnapshot",
    method: "GET",
    path: (f) => `/api/v1/archive/snapshots/${f.snapshotA}`,
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "archive.getSnapshotCostEstimate",
    method: "GET",
    path: (f) => `/api/v1/archive/snapshots/${f.snapshotA}/cost-estimate`,
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "archive.takeSnapshot",
    method: "POST",
    path: (f) => `/api/v1/archive/machines/${f.machineA}/snapshots`,
    body: () => ({ scope: "shallow" }),
    allow: OWNER_OR_ADMIN,
  },
  {
    endpoint: "archive.openInspection",
    method: "POST",
    path: (f) => `/api/v1/archive/snapshots/${f.snapshotA}/inspections`,
    // The owner looks at their own snapshot. Nobody else, admins included.
    allow: OWNER,
  },

  // --- people ---
  { endpoint: "people.me", method: "GET", path: () => "/api/v1/me", allow: EVERYONE },
  { endpoint: "people.list", method: "GET", path: () => "/api/v1/people", allow: EVERYONE },
  {
    endpoint: "people.create",
    method: "POST",
    path: () => "/api/v1/people",
    body: () => ({ email: `new-${crypto.randomUUID()}@example.com`, role: "member" }),
    allow: ADMIN,
  },
  {
    endpoint: "people.update",
    method: "PATCH",
    path: (f) => `/api/v1/people/${f.people.otherMember}`,
    body: () => ({ email: `moved-${crypto.randomUUID()}@example.com` }),
    allow: ADMIN,
  },
  {
    endpoint: "people.setActive",
    method: "PATCH",
    path: (f) => `/api/v1/people/${f.people.otherMember}/active`,
    body: () => ({ active: false }),
    allow: ADMIN,
  },
  {
    endpoint: "offboarding.offboardPerson",
    method: "POST",
    path: () => "/api/v1/offboarding",
    body: (f) => ({ personId: f.people.otherMember, reason: "test" }),
    allow: ADMIN,
  },
  {
    endpoint: "offboarding.sync",
    method: "POST",
    path: (f) => `/api/v1/offboarding/${f.packageApprovalA}/sync`,
    allow: ADMIN,
  },

  // --- organisation and configuration ---
  {
    endpoint: "organisation.get",
    method: "GET",
    path: () => "/api/v1/organisation",
    allow: EVERYONE,
  },
  {
    endpoint: "organisation.update",
    method: "PATCH",
    path: () => "/api/v1/organisation",
    body: () => ({ name: "Renamed" }),
    allow: ADMIN,
  },
  {
    endpoint: "organisation.requestApprovalModesChange",
    method: "POST",
    path: () => "/api/v1/organisation/approval-modes",
    body: () => ({ approvalModes: { snapshot_restore: "dual" }, reason: "test" }),
    allow: ADMIN,
  },
  {
    endpoint: "organisation.listPackages",
    method: "GET",
    path: () => "/api/v1/organisation/packages",
    allow: EVERYONE,
  },
  {
    endpoint: "organisation.updatePackages",
    method: "PATCH",
    path: () => "/api/v1/organisation/packages",
    body: () => ({ upserts: [{ packageName: "jq" }] }),
    allow: ADMIN,
  },
  {
    endpoint: "config.patchSetting",
    method: "PATCH",
    path: () => "/api/v1/config/settings",
    body: (f) => ({ scopeType: "org", scopeId: f.orgId, key: "example_key", value: 1 }),
    allow: ADMIN,
  },
  {
    endpoint: "config.importConfig",
    method: "POST",
    path: () => "/api/v1/config/import",
    body: (f) => ({
      entries: [{ scopeType: "org", scopeId: f.orgId, key: "example_key", value: 1 }],
    }),
    allow: ADMIN,
  },
  {
    endpoint: "vulnerability-scan.get",
    method: "GET",
    path: () => "/api/v1/vulnerability-scan",
    allow: EVERYONE,
  },
  {
    endpoint: "vulnerability-scan.update",
    method: "PATCH",
    path: () => "/api/v1/vulnerability-scan",
    body: () => ({ enabled: false }),
    allow: ADMIN,
  },
  {
    endpoint: "integrations.list",
    method: "GET",
    path: () => "/api/v1/integrations",
    allow: ADMIN,
  },
  {
    endpoint: "integrations.connect",
    method: "POST",
    path: () => "/api/v1/integrations",
    body: () => ({ kind: "secret_store", identifier: "kv-test", config: {} }),
    allow: ADMIN,
  },
  {
    endpoint: "integrations.disconnect",
    method: "POST",
    path: (f) => `/api/v1/integrations/${f.integrationId}/disconnect`,
    allow: ADMIN,
  },
  {
    endpoint: "catalog.list",
    method: "GET",
    path: () => "/api/v1/organisation/catalog/azure/sku",
    allow: EVERYONE,
  },
  {
    endpoint: "catalog.syncRegions",
    method: "POST",
    path: () => "/api/v1/organisation/catalog/azure/regions/sync",
    allow: ADMIN,
    skipAllowed: "calls the Azure management API",
  },
  {
    endpoint: "catalog.syncSizes",
    method: "POST",
    path: () => "/api/v1/organisation/catalog/azure/sizes/sync",
    allow: ADMIN,
    skipAllowed: "calls the Azure management API",
  },
  {
    endpoint: "provisioningCapabilities.get",
    method: "GET",
    path: () => "/api/v1/provisioning/capabilities",
    allow: EVERYONE,
  },

  // --- audit and compliance: admin only ---
  { endpoint: "evidence.list", method: "GET", path: () => "/api/v1/evidence", allow: ADMIN },
  {
    endpoint: "compliance.controlMap",
    method: "GET",
    path: () => "/api/v1/compliance/control-map",
    allow: ADMIN,
  },
  {
    endpoint: "compliance.setControlOverride",
    method: "PATCH",
    path: () => "/api/v1/compliance/control-map/CC6.1/override",
    body: () => ({ status: null }),
    allow: ADMIN,
  },
  {
    endpoint: "compliance.findings",
    method: "GET",
    path: () => "/api/v1/compliance/findings",
    allow: ADMIN,
  },
  {
    endpoint: "compliance.findingsExport",
    method: "GET",
    path: () => "/api/v1/compliance/findings/export",
    allow: ADMIN,
  },
  {
    endpoint: "compliance.assetInventoryCsv",
    method: "GET",
    path: () => "/api/v1/compliance/exports/asset-inventory.csv",
    allow: ADMIN,
  },
  {
    endpoint: "compliance.findingsCsv",
    method: "GET",
    path: () => "/api/v1/compliance/exports/findings.csv",
    allow: ADMIN,
  },
  {
    endpoint: "compliance.vulnerabilitiesCsv",
    method: "GET",
    path: () => "/api/v1/compliance/exports/vulnerabilities.csv",
    allow: ADMIN,
  },

  // --- a person's own things ---
  {
    endpoint: "notifications.list",
    method: "GET",
    path: () => "/api/v1/notifications",
    allow: EVERYONE,
  },
  {
    endpoint: "notifications.markRead",
    method: "POST",
    path: () => "/api/v1/notifications/read",
    body: () => ({ ids: [] }),
    allow: EVERYONE,
  },
  {
    endpoint: "cliAuth.mintCode",
    method: "POST",
    path: () => "/api/v1/cli-auth/code",
    allow: EVERYONE,
  },
];

describe.skipIf(!postgresReachable)(
  "authorization matrix (requires Postgres at DATABASE_URL)",
  () => {
    const sql = postgres(DATABASE_URL, { max: 4 });
    const db = drizzle(sql, { schema });
    const orgIds: string[] = [];

    const { handler, dispose } = (() => {
      const AppLive = buildAppLive({
        provisioning: FakeProvisioningServiceLive,
        signer: LocalSignerLive,
        secrets: FakeSecretsProviderLive,
      });
      return HttpApiBuilderToWebHandler(AppLive);
    })();

    const seed = async (): Promise<Fixture> => {
      const [org] = await db
        .insert(orgs)
        .values({ name: `authz-${crypto.randomUUID()}` })
        .returning();
      if (!org) throw new Error("org insert failed");
      orgIds.push(org.id);
      const person = async (role: string, extra: Partial<typeof people.$inferInsert> = {}) => {
        const [row] = await db
          .insert(people)
          .values({ orgId: org.id, email: `${crypto.randomUUID()}@example.com`, role, ...extra })
          .returning();
        if (!row) throw new Error("person insert failed");
        return row.id;
      };
      const ids = {
        owner: await person("member"),
        otherMember: await person("member"),
        admin: await person("owner"),
        approver: await person("member", { approver: true }),
        deactivated: await person("member", { active: false }),
      };
      const machine = async (ownerPersonId: string, name: string) => {
        const [row] = await db
          .insert(machines)
          .values({
            orgId: org.id,
            ownerPersonId,
            name,
            provider: "fake",
            region: null,
            sizeSku: "Standard_B2s",
            image: "ubuntu-24.04",
            state: "running",
          })
          .returning();
        if (!row) throw new Error("machine insert failed");
        return row.id;
      };
      const machineA = await machine(ids.owner, "machine-a");
      const machineB = await machine(ids.otherMember, "machine-b");
      const [snapshot] = await db
        .insert(snapshots)
        .values({
          orgId: org.id,
          machineId: machineA,
          trigger: "manual",
          retentionDays: 30,
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
          capturedDisks: [
            { kind: "data", externalId: `snap-${crypto.randomUUID()}`, sizeBytes: 1 },
          ],
        })
        .returning();
      const [session] = await db
        .insert(sessions)
        .values({
          orgId: org.id,
          machineId: machineA,
          personId: ids.owner,
          method: "terminal",
          osUser: "cloudable",
        })
        .returning();
      const [certificate] = await db
        .insert(certificates)
        .values({
          orgId: org.id,
          personId: ids.owner,
          machineScope: [machineA],
          fingerprint: `SHA256:${crypto.randomUUID()}`,
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning();
      const [approval] = await db
        .insert(approvals)
        .values({
          orgId: org.id,
          actionType: "package_install",
          mode: "single",
          requestedByPersonId: ids.owner,
          targetMachineId: machineA,
          reason: "need htop",
          payload: {
            packageName: "htop",
            op: "install",
            versionPin: null,
            isBaselinePackage: false,
          },
          requiredApprovals: 1,
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning();
      const [elevation] = await db
        .insert(elevations)
        .values({
          orgId: org.id,
          personId: ids.admin,
          machineId: machineA,
          level: "shell",
          reason: "before the pin",
          status: "granted",
          grantedAt: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning();
      const [integration] = await db
        .insert(integrations)
        .values({ orgId: org.id, kind: "cloud", provider: "fake", identifier: "fake", config: {} })
        .returning();
      if (!snapshot || !session || !certificate || !approval || !elevation || !integration) {
        throw new Error("fixture insert failed");
      }
      const tokens = Object.fromEntries(
        Object.entries(ids).map(([role, personId]) => [role, issueCliToken({ personId })]),
      ) as Fixture["tokens"];
      return {
        orgId: org.id,
        people: ids,
        tokens,
        machineA,
        machineB,
        snapshotA: snapshot.id,
        sessionA: session.id,
        certificateA: certificate.id,
        packageApprovalA: approval.id,
        elevationByAdmin: elevation.id,
        integrationId: integration.id,
      };
    };

    const call = async (
      token: string,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; body: unknown }> => {
      const response = await handler(
        new Request(`http://test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(json(body)) } : {}),
        }),
      );
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { status: response.status, body: parsed };
    };

    afterAll(async () => {
      await dispose();
      if (orgIds.length > 0) {
        const orgMachines = db
          .select({ id: machines.id })
          .from(machines)
          .where(inArray(machines.orgId, orgIds));
        await db
          .delete(machinePackageActions)
          .where(inArray(machinePackageActions.machineId, orgMachines));
        await db.delete(events).where(inArray(events.orgId, orgIds));
        await db.delete(settingValues).where(inArray(settingValues.scopeId, orgIds));
        await db.delete(sessions).where(inArray(sessions.orgId, orgIds));
        await db.delete(certificates).where(inArray(certificates.orgId, orgIds));
        await db.delete(elevations).where(inArray(elevations.orgId, orgIds));
        await db.delete(snapshots).where(inArray(snapshots.orgId, orgIds));
        await db.delete(integrations).where(inArray(integrations.orgId, orgIds));
      }
      await sql.end();
    });

    test("every person-authenticated endpoint has a row in this matrix", () => {
      const declared: string[] = [];
      HttpApi.reflect(Api, {
        onGroup: () => {},
        onEndpoint: ({ group, endpoint }) => declared.push(`${group.identifier}.${endpoint.name}`),
      });
      const covered = new Set([
        ...CASES.map((c) => c.endpoint),
        ...Object.keys(NOT_PERSON_AUTHENTICATED),
      ]);
      expect(declared.filter((name) => !covered.has(name))).toEqual([]);
      // And nothing here names an endpoint that no longer exists.
      expect([...covered].filter((name) => !declared.includes(name))).toEqual([]);
    });

    for (const c of CASES) {
      for (const role of ROLES) {
        const allowed = c.allow.includes(role);
        if (allowed && c.skipAllowed) continue;
        test(`${c.endpoint} as ${role}: ${allowed ? "allowed" : "refused"}`, async () => {
          const f = await seed();
          const res = await call(f.tokens[role], c.method, c.path(f), c.body?.(f));
          const detail = `${c.method} ${c.path(f)} -> ${res.status} ${JSON.stringify(res.body)}`;
          if (process.env.AUTHZ_MATRIX_TRACE)
            console.log(`TRACE ${role} ${allowed ? "allow" : "deny"} ${detail.slice(0, 220)}`);
          if (allowed) {
            expect([401, 403], detail).not.toContain(res.status);
            // A role-check 404 names the machine it hid; a domain 404 is the endpoint's own.
            expect((res.body as { _tag?: string })?._tag, detail).not.toBe(
              "MachineNotVisibleError",
            );
          } else {
            expect([403, 404], detail).toContain(res.status);
          }
        });
      }
    }

    test("people permission events identify the actor, target and granted privileges", async () => {
      const f = await seed();
      const created = await call(f.tokens.admin, "POST", "/api/v1/people", {
        email: `privileged-${crypto.randomUUID()}@example.com`,
        role: "admin",
      });
      expect(created.status).toBe(201);
      const personId = (created.body as { id: string }).id;
      expect(
        (
          await call(f.tokens.admin, "PATCH", `/api/v1/people/${personId}`, {
            role: "owner",
            approver: true,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call(f.tokens.admin, "PATCH", `/api/v1/people/${personId}/active`, {
            active: false,
          })
        ).status,
      ).toBe(200);
      expect(
        (await call(f.tokens.admin, "PATCH", `/api/v1/people/${personId}/active`, { active: true }))
          .status,
      ).toBe(200);
      const rows = await db.select().from(events).where(eq(events.orgId, f.orgId));
      for (const type of [
        "person.added",
        "person.role_changed",
        "person.approver_changed",
        "person.activated",
      ]) {
        const event = rows.find((row) => row.type === type);
        expect(event?.actorId).toBe(f.people.admin);
        expect(event?.payload).toMatchObject({ personId });
      }
      expect(rows.find((row) => row.type === "person.added")?.payload).toMatchObject({
        role: "admin",
        approver: false,
      });
      expect(rows.find((row) => row.type === "person.role_changed")?.payload).toMatchObject({
        previous: "admin",
        current: "owner",
      });
      expect(rows.find((row) => row.type === "person.approver_changed")?.payload).toMatchObject({
        previous: false,
        current: true,
      });
      expect(rows.find((row) => row.type === "person.activated")?.payload).toMatchObject({
        role: "owner",
        approver: true,
      });
    });

    test("a deactivated person is refused on every endpoint, with 401", async () => {
      const f = await seed();
      for (const c of CASES) {
        const res = await call(f.tokens.deactivated, c.method, c.path(f), c.body?.(f));
        expect(res.status, `${c.endpoint} -> ${res.status}`).toBe(401);
      }
    });

    describe("what each person sees in a list", () => {
      const ids = (body: unknown, key: string) =>
        ((body as Record<string, Array<{ id?: string; machineId?: string }>>)[key] ?? []).map(
          (row) => row.id,
        );

      test("machines: a member sees only their own; an admin sees all", async () => {
        const f = await seed();
        expect(ids((await call(f.tokens.owner, "GET", "/api/v1/machines")).body, "items")).toEqual([
          f.machineA,
        ]);
        expect(
          ids((await call(f.tokens.otherMember, "GET", "/api/v1/machines")).body, "items"),
        ).toEqual([f.machineB]);
        expect(
          ids((await call(f.tokens.approver, "GET", "/api/v1/machines")).body, "items"),
        ).toEqual([]);
        expect(
          ids((await call(f.tokens.admin, "GET", "/api/v1/machines")).body, "items").sort(),
        ).toEqual([f.machineA, f.machineB].sort());
      });

      test("sessions, certificates, snapshots, approvals: a member sees only their own", async () => {
        const f = await seed();
        const other = f.tokens.otherMember;
        expect(ids((await call(other, "GET", "/api/v1/access/sessions")).body, "sessions")).toEqual(
          [],
        );
        expect(
          ids((await call(other, "GET", "/api/v1/access/certificates")).body, "certificates"),
        ).toEqual([]);
        expect(ids((await call(other, "GET", "/api/v1/archive/snapshots")).body, "items")).toEqual(
          [],
        );
        expect(ids((await call(other, "GET", "/api/v1/approvals")).body, "items")).toEqual([]);
        expect(
          ids((await call(f.tokens.owner, "GET", "/api/v1/access/sessions")).body, "sessions"),
        ).toEqual([f.sessionA]);
        expect(
          ids((await call(f.tokens.approver, "GET", "/api/v1/approvals")).body, "items"),
        ).toEqual([f.packageApprovalA]);
      });

      test("people: a member sees only themselves; approvers and admins see the roster", async () => {
        const f = await seed();
        expect(ids((await call(f.tokens.owner, "GET", "/api/v1/people")).body, "items")).toEqual([
          f.people.owner,
        ]);
        expect(
          ids((await call(f.tokens.approver, "GET", "/api/v1/people")).body, "items").length,
        ).toBe(5);
      });
    });

    // -------------------------------------------------------------------------
    // The three bypass chains from the investigation. Each was a member reaching
    // another person's machine or data through a few ordinary API calls.
    // -------------------------------------------------------------------------
    describe("chain A: a member cannot reach a shell on someone else's machine", () => {
      test("loosening admin_access_policy is refused, for members and admins alike", async () => {
        const f = await seed();
        for (const role of ["otherMember", "admin"] as const) {
          const res = await call(f.tokens[role], "PATCH", "/api/v1/config/settings", {
            scopeType: "org",
            scopeId: f.orgId,
            key: "admin_access_policy",
            value: "always",
          });
          expect(res.status, role).toBe(403);
        }
      });

      test("even with a stale 'always' row in the database, nobody gets an elevation or a shell", async () => {
        const f = await seed();
        await db.insert(settingValues).values({
          scopeType: "org",
          scopeId: f.orgId,
          key: "admin_access_policy",
          value: "always",
          source: "org",
        });
        for (const role of ["otherMember", "admin"] as const) {
          const elevation = await call(f.tokens[role], "POST", "/api/v1/elevations", {
            machineId: f.machineA,
            level: "shell",
            reason: "x",
          });
          expect([403, 404], role).toContain(elevation.status);
          const shell = await call(f.tokens[role], "POST", "/api/v1/access/sessions", {
            targetMachineId: f.machineA,
            method: "terminal",
          });
          expect(shell.status, role).toBe(403);
        }
        // The admin's elevation from before the pin opens nothing either.
        const files = await call(f.tokens.admin, "POST", "/api/v1/access/sessions", {
          targetMachineId: f.machineA,
          method: "files",
        });
        expect(files.status).toBe(403);
      });

      test("a machine with no owner is open to nobody", async () => {
        const f = await seed();
        await db.update(machines).set({ ownerPersonId: null }).where(eq(machines.id, f.machineA));
        for (const role of ROLES) {
          const res = await call(f.tokens[role], "POST", "/api/v1/access/sessions", {
            targetMachineId: f.machineA,
            method: "terminal",
          });
          expect([403, 404], role).toContain(res.status);
        }
      });

      test("another member's approval cannot open it: they are not an approver", async () => {
        const f = await seed();
        const res = await call(
          f.tokens.otherMember,
          "POST",
          `/api/v1/approvals/${f.packageApprovalA}/decide`,
          {
            decision: "approved",
          },
        );
        expect(res.status).toBe(403);
      });
    });

    describe("chain B: a member cannot take over someone else's identity", () => {
      test("a member cannot change anyone's email, their own included", async () => {
        const f = await seed();
        for (const target of [f.people.admin, f.people.otherMember]) {
          const res = await call(f.tokens.otherMember, "PATCH", `/api/v1/people/${target}`, {
            email: "attacker@example.com",
          });
          expect(res.status).toBe(403);
        }
      });

      test("when an admin changes an email, every credential the person held stops working", async () => {
        const f = await seed();
        expect((await call(f.tokens.otherMember, "GET", "/api/v1/me")).status).toBe(200);
        const changed = await call(
          f.tokens.admin,
          "PATCH",
          `/api/v1/people/${f.people.otherMember}`,
          {
            email: `renamed-${crypto.randomUUID()}@example.com`,
          },
        );
        expect(changed.status).toBe(200);
        expect((await call(f.tokens.otherMember, "GET", "/api/v1/me")).status).toBe(401);
        // A token issued after the change works.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const fresh = issueCliToken({ personId: f.people.otherMember });
        expect((await call(fresh, "GET", "/api/v1/me")).status).toBe(200);
        const recorded = await db
          .select({ type: events.type })
          .from(events)
          .where(and(eq(events.orgId, f.orgId), eq(events.type, "person.email_changed")));
        expect(recorded).toHaveLength(1);
      });

      test("a member cannot add a person, so cannot add an outside email to sign in with", async () => {
        const f = await seed();
        const res = await call(f.tokens.otherMember, "POST", "/api/v1/people", {
          email: "outsider@example.com",
          role: "member",
        });
        expect(res.status).toBe(403);
      });
    });

    describe("chain C: a member cannot copy someone else's data", () => {
      test("approval modes cannot be loosened through the organisation or config endpoints", async () => {
        const f = await seed();
        for (const role of ["otherMember", "admin"] as const) {
          const org = await call(f.tokens[role], "PATCH", "/api/v1/organisation", {
            approvalModes: { snapshot_restore: "none" },
          });
          expect(org.status, role).toBeGreaterThanOrEqual(400);
          const cfg = await call(f.tokens[role], "PATCH", "/api/v1/config/settings", {
            scopeType: "org",
            scopeId: f.orgId,
            key: "approval_mode:snapshot_restore",
            value: "none",
          });
          expect(cfg.status, role).toBe(403);
        }
        const after = await call(f.tokens.admin, "GET", "/api/v1/organisation");
        expect(
          (after.body as { approvalModes: Record<string, string> }).approvalModes.snapshot_restore,
        ).toBe("single");
      });

      test("nobody can snapshot someone else's machine as a member, or restore it to a different owner", async () => {
        const f = await seed();
        const take = await call(
          f.tokens.otherMember,
          "POST",
          `/api/v1/archive/machines/${f.machineA}/snapshots`,
          { scope: "shallow" },
        );
        expect([403, 404]).toContain(take.status);
        for (const role of ROLES) {
          const restore = await call(
            f.tokens[role],
            "POST",
            `/api/v1/archive/snapshots/${f.snapshotA}/restore`,
            {
              mode: "data",
              target: { kind: "new_machine", ownerPersonId: f.people.otherMember },
              reason: "x",
            },
          );
          expect([403, 404], role).toContain(restore.status);
        }
      });
    });

    // -------------------------------------------------------------------------
    // The approval flows that replace the open paths.
    // -------------------------------------------------------------------------
    describe("package installs need an approval", () => {
      test("the owner asks, nothing is queued, an approver says yes, then it is queued", async () => {
        const f = await seed();
        const asked = await call(
          f.tokens.owner,
          "POST",
          `/api/v1/machines/${f.machineA}/packages/ripgrep/actions`,
          { op: "install", reason: "search" },
        );
        expect(asked.status).toBe(202);
        const body = asked.body as { action: unknown; approval: { id: string; status: string } };
        expect(body.action).toBeNull();
        expect(body.approval.status).toBe("pending");
        const queuedBefore = await db
          .select()
          .from(machinePackageActions)
          .where(eq(machinePackageActions.machineId, f.machineA));
        expect(queuedBefore).toHaveLength(0);

        // The owner cannot approve it; another member cannot either.
        for (const role of ["owner", "otherMember"] as const) {
          const res = await call(
            f.tokens[role],
            "POST",
            `/api/v1/approvals/${body.approval.id}/decide`,
            {
              decision: "approved",
            },
          );
          expect(res.status, role).toBe(403);
        }
        const decided = await call(
          f.tokens.approver,
          "POST",
          `/api/v1/approvals/${body.approval.id}/decide`,
          {
            decision: "approved",
          },
        );
        expect(decided.status).toBe(200);
        const queued = await db
          .select()
          .from(machinePackageActions)
          .where(eq(machinePackageActions.machineId, f.machineA));
        expect(queued.map((row) => [row.packageName, row.requestedByPersonId])).toEqual([
          ["ripgrep", f.people.owner],
        ]);
      });

      test("a removal is queued straight away", async () => {
        const f = await seed();
        const res = await call(
          f.tokens.owner,
          "POST",
          `/api/v1/machines/${f.machineA}/packages/ripgrep/actions`,
          { op: "uninstall" },
        );
        expect(res.status).toBe(202);
        expect((res.body as { approval: unknown; action: { op: string } }).action.op).toBe(
          "uninstall",
        );
      });

      test("an approver who owns the machine cannot approve an install on it", async () => {
        const f = await seed();
        await db.update(people).set({ approver: true }).where(eq(people.id, f.people.otherMember));
        const asked = await call(
          f.tokens.admin,
          "POST",
          `/api/v1/machines/${f.machineB}/packages/ripgrep/actions`,
          { op: "install" },
        );
        const approvalId = (asked.body as { approval: { id: string } }).approval.id;
        const res = await call(
          f.tokens.otherMember,
          "POST",
          `/api/v1/approvals/${approvalId}/decide`,
          {
            decision: "approved",
          },
        );
        expect(res.status).toBe(403);
      });
    });

    describe("approval settings change only with an approver's sign-off", () => {
      test("an admin asks; another admin cannot sign off; an approver can, and then it applies", async () => {
        const f = await seed();
        const secondAdmin = (
          await db
            .insert(people)
            .values({ orgId: f.orgId, email: `${crypto.randomUUID()}@example.com`, role: "admin" })
            .returning()
        )[0];
        if (!secondAdmin) throw new Error("insert failed");
        const asked = await call(f.tokens.admin, "POST", "/api/v1/organisation/approval-modes", {
          approvalModes: { package_install: "dual" },
          reason: "tighten",
        });
        expect(asked.status).toBe(202);
        const approvalId = (asked.body as { id: string }).id;

        const before = await call(f.tokens.admin, "GET", "/api/v1/organisation");
        expect(
          (before.body as { approvalModes: Record<string, string> }).approvalModes.package_install,
        ).toBe("single");

        const byAdmin = await call(
          issueCliToken({ personId: secondAdmin.id }),
          "POST",
          `/api/v1/approvals/${approvalId}/decide`,
          { decision: "approved" },
        );
        expect(byAdmin.status).toBe(403);

        const byApprover = await call(
          f.tokens.approver,
          "POST",
          `/api/v1/approvals/${approvalId}/decide`,
          {
            decision: "approved",
          },
        );
        expect(byApprover.status).toBe(200);
        const after = await call(f.tokens.admin, "GET", "/api/v1/organisation");
        expect(
          (after.body as { approvalModes: Record<string, string> }).approvalModes.package_install,
        ).toBe("dual");
      });
    });

    describe("SSH certificates name only the person's own machines", () => {
      const publicKeyBase64 = () =>
        Buffer.from(
          crypto
            .generateKeyPairSync("ed25519")
            .publicKey.export({ type: "spki", format: "der" })
            .subarray(-32),
        ).toString("base64");
      const issue = (f: Fixture, role: Role | "deactivated", machineScope: unknown) =>
        call(f.tokens.owner, "POST", "/api/v1/access/certificates", {
          code: issueCliAuthCode({ personId: f.people[role], orgId: f.orgId }),
          osUser: "cloudable",
          machineScope,
          publicKeyBase64: publicKeyBase64(),
        });

      test("asking for someone else's machine is refused, admins included", async () => {
        const f = await seed();
        for (const role of ["otherMember", "admin", "approver"] as const) {
          const res = await issue(f, role, [f.machineA]);
          expect(res.status, role).toBe(403);
        }
      });

      test('"all" is narrowed to the machines the person owns', async () => {
        const f = await seed();
        const res = await issue(f, "otherMember", "all");
        expect(res.status).toBe(200);
        const id = (res.body as { certificateId: string }).certificateId;
        const [row] = await db.select().from(certificates).where(eq(certificates.id, id));
        expect(row?.machineScope).toEqual([f.machineB]);
      });

      test("a deactivated person gets no certificate", async () => {
        const f = await seed();
        expect((await issue(f, "deactivated", "all")).status).toBe(403);
      });
    });

    describe("creating a machine", () => {
      test("the owner must be an active person of this org with no other live machine", async () => {
        const f = await seed();
        const create = (ownerPersonId: string) =>
          call(f.tokens.admin, "POST", "/api/v1/machines", {
            provider: "fake",
            sizeSku: "Standard_B2s",
            image: "ubuntu-24.04",
            ownerPersonId,
          });
        expect((await create(f.people.owner)).status).toBe(422);
        expect((await create(f.people.deactivated)).status).toBe(422);
        expect((await create(crypto.randomUUID())).status).toBe(422);
      });
    });
  },
);

/** `HttpApiBuilder.toWebHandler` over the real API, with the app's services provided. */
function HttpApiBuilderToWebHandler(AppLive: ReturnType<typeof buildAppLive>) {
  return HttpApiBuilder.toWebHandler(
    Layer.mergeAll(ApiLive, HttpServer.layerContext).pipe(Layer.provide(AppLive)),
  );
}
