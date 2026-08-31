#!/usr/bin/env bun
import { generateKeyPairSync } from "node:crypto";
/**
 * Dev-only demo seed: populates a coherent, realistic dataset across every
 * domain that has a real backend today (machines, approvals, SSH
 * certificates, sessions, elevations, one archived machine/snapshot).
 *
 * Org and people are inserted directly via Drizzle — there is no People or
 * Organisation HTTP surface in this build (no unit owns one yet), so a
 * direct DB write is the only way to get a valid `personId` to reference.
 * Everything else goes through the REAL running control-plane's HTTP API,
 * deliberately, rather than being inserted directly: that's the only way to
 * be sure the seeded data is actually shaped the way the real business
 * logic (invariants, event emission, cursor pagination) produces it,
 * instead of a second, hand-maintained copy that can drift from the real
 * implementation — the exact "silent duplication" failure mode this build
 * hit more than once during its own merge.
 *
 * Usage: control-plane must already be running (bun run dev:control-plane),
 * then from the repo root: bun run --cwd apps/control-plane seed:demo
 */
import * as schema from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../src/config";

const API_BASE = process.env.SEED_API_BASE ?? `http://localhost:${config.port}`;

async function api<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/** Ed25519 public keys travel as a raw 32-byte point, base64-encoded — see
 * `SshCaService.issueCertificate`'s length check. */
function generateEd25519PublicKeyBase64(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  // SPKI wraps the raw 32-byte point in a fixed 12-byte header for Ed25519 keys.
  const raw = der.subarray(der.length - 32);
  return Buffer.from(raw).toString("base64");
}

const sql = postgres(config.databaseUrl);
const db = drizzle(sql, { schema });

// Fixed, not random — matches `apps/console/src/lib/current-org.ts`'s
// CURRENT_ORG_ID, so the console needs zero configuration to find this
// org's data after a reseed.
const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";
// Matches `apps/console/src/lib/current-person.ts`'s CURRENT_PERSON_ID —
// see that file's doc comment. Assigned to Jordan below.
const CURRENT_PERSON_ID = "00000000-0000-0000-0000-000000000002";

async function main() {
  console.log(`Seeding demo data against ${API_BASE} ...`);

  const [existing] = await db
    .select({ id: schema.orgs.id })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, DEMO_ORG_ID))
    .limit(1);
  if (existing) {
    throw new Error(
      `Demo org ${DEMO_ORG_ID} already exists — this script is not idempotent (fixed id, real business-logic side effects). Truncate every table before re-running.`,
    );
  }

  const [org] = await db
    .insert(schema.orgs)
    .values({ id: DEMO_ORG_ID, name: "Acme Corp" })
    .returning();
  if (!org) throw new Error("failed to insert org");
  console.log(`org: ${org.id} (Acme Corp)`);

  const peopleInput = [
    { email: "priya.natarajan@acme.com", role: "owner" as const },
    { email: "marcus.webb@acme.com", role: "member" as const },
    { email: "elena.ruiz@acme.com", role: "member" as const },
    // Fixed id — matches `apps/console/src/lib/current-person.ts`'s
    // CURRENT_PERSON_ID, the same "no auth yet" stopgap CURRENT_ORG_ID
    // above stands in for. Jordan owns staging-07, the machine the demo
    // elevation below targets, so a reseed leaves Jordan with one real
    // unread owner notification (spec §15) with zero further configuration.
    { id: CURRENT_PERSON_ID, email: "jordan.blake@acme.com", role: "member" as const },
    { email: "sam.okafor@acme.com", role: "member" as const },
  ];
  const people = await db
    .insert(schema.people)
    .values(
      peopleInput.map((p) => ({
        ...("id" in p ? { id: p.id } : {}),
        orgId: org.id,
        email: p.email,
        source: "manual" as const,
        active: true,
        role: p.role,
      })),
    )
    .returning();
  console.log(`people: ${people.length} rows`);
  const [priya, marcus, elena, jordan, sam] = people;
  if (!priya || !marcus || !elena || !jordan || !sam) throw new Error("failed to insert people");

  // --- Machines (real POST /api/v1/machines) -------------------------------
  const machineDefs = [
    {
      name: "db-prod-03",
      region: "eastus",
      sizeSku: "Standard_D4s_v5",
      image: "ubuntu-22.04",
      owner: priya,
    },
    {
      name: "build-runner-11",
      region: "eastus",
      sizeSku: "Standard_D2s_v5",
      image: "ubuntu-22.04",
      owner: marcus,
    },
    {
      name: "analytics-02",
      region: "westeurope",
      sizeSku: "Standard_D8s_v5",
      image: "ubuntu-22.04",
      owner: elena,
    },
    {
      name: "staging-07",
      region: "westeurope",
      sizeSku: "Standard_D2s_v5",
      image: "ubuntu-22.04",
      owner: jordan,
    },
    {
      name: "worker-04",
      region: "eastus",
      sizeSku: "Standard_D4s_v5",
      image: "ubuntu-22.04",
      owner: sam,
    },
  ];
  const machines: { id: string; name: string; ownerPersonId: string }[] = [];
  for (const m of machineDefs) {
    const created = await api<{ id: string }>("POST", "/api/v1/machines", {
      orgId: org.id,
      name: m.name,
      region: m.region,
      sizeSku: m.sizeSku,
      image: m.image,
      ownerPersonId: m.owner.id,
    });
    machines.push({ id: created.id, name: m.name, ownerPersonId: m.owner.id });
  }
  // Every new machine starts in `provisioning` (the real create handler's
  // correct default) and only leaves it once the reconcile loop calls
  // `ProvisioningService.create`/`.reconcile` and observes it come up. No
  // reconcile loop actually runs continuously in a dev session, so nothing
  // would ever move these machines to `running` on its own — flip it
  // directly here to stand in for a fleet that already finished
  // provisioning, since that's the realistic demo state.
  await db
    .update(schema.machines)
    .set({ state: "running", lastVerifiedAt: new Date() })
    .where(eq(schema.machines.orgId, org.id));
  console.log(`machines: ${machines.length} created`);
  const [dbProd, buildRunner, analytics, staging, worker] = machines;
  if (!dbProd || !buildRunner || !analytics || !staging || !worker) {
    throw new Error("failed to create machines");
  }

  // --- Approvals (real POST /api/v1/approvals, some decided via decide) ----
  const pendingBreakGlass = await api<{ id: string }>("POST", "/api/v1/approvals", {
    orgId: org.id,
    actionType: "break_glass",
    requestedByPersonId: priya.id,
    targetMachineId: dbProd.id,
    reason: "Customer P1 — production database locked, need shell to unblock a stuck migration.",
  });
  await api("POST", `/api/v1/approvals/${pendingBreakGlass.id}/decide`, {
    personId: elena.id,
    decision: "approved",
  });

  await api("POST", "/api/v1/approvals", {
    orgId: org.id,
    actionType: "snapshot_restore",
    requestedByPersonId: marcus.id,
    targetMachineId: buildRunner.id,
    reason: "Restore last night's snapshot after a bad config push wiped local state.",
  });

  const restoreToDeny = await api<{ id: string }>("POST", "/api/v1/approvals", {
    orgId: org.id,
    actionType: "snapshot_restore",
    requestedByPersonId: jordan.id,
    targetMachineId: staging.id,
    reason: "Restore full config and secret bindings to a two-week-old snapshot.",
  });
  await api("POST", `/api/v1/approvals/${restoreToDeny.id}/decide`, {
    personId: priya.id,
    decision: "rejected",
    reason: "Secret bindings are stale — re-provision the machine instead of restoring them.",
  });

  await api("POST", "/api/v1/approvals", {
    orgId: org.id,
    actionType: "admin_access",
    requestedByPersonId: elena.id,
    targetMachineId: analytics.id,
    reason: "Owner is on leave; need to pull a log file for the SOC2 auditor's sample request.",
  });
  console.log("approvals: 4 created (1 approved, 1 rejected, 2 pending)");

  // --- SSH certificates (real POST /api/v1/access/certificates) ------------
  for (const [person, osUser] of [
    [priya, "priya"],
    [marcus, "marcus"],
  ] as const) {
    await api("POST", "/api/v1/access/certificates", {
      orgId: org.id,
      personId: person.id,
      osUser,
      machineScope: "all",
      publicKeyBase64: generateEd25519PublicKeyBase64(),
    });
  }
  console.log("certificates: 2 issued");

  // --- Active session (real POST /api/v1/access/sessions) ------------------
  await api("POST", "/api/v1/access/sessions", {
    orgId: org.id,
    personId: marcus.id,
    idpIdentity: marcus.email,
    targetMachineId: buildRunner.id,
    targetOsUser: "marcus",
    method: "terminal",
  });
  console.log("sessions: 1 minted (active)");

  // --- Elevation request (real POST /api/v1/elevations) --------------------
  // Elevation is specifically for admin access to a machine the requester does
  // NOT own (spec §15) — a self-owned target is rejected with
  // SelfOwnedMachineError, so this has to be someone other than staging's owner.
  const elevation = await api<{ id: string; approvalId: string | null }>(
    "POST",
    "/api/v1/elevations",
    {
      personId: priya.id,
      machineId: staging.id,
      level: "file_recovery",
      reason: "Pulling a log file for the SOC2 auditor's sample request while Jordan is out.",
    },
  );
  // Decided and synced to granted (rather than left pending) so the demo
  // also exercises the real owner-notification flow (spec §15: "owner
  // notified") — Jordan (staging's owner, and this build's fixed
  // CURRENT_PERSON_ID — see apps/console/src/lib/current-person.ts) has one
  // real unread notification after this reseed.
  if (!elevation.approvalId) throw new Error("expected the elevation to have an approvalId");
  await api("POST", `/api/v1/approvals/${elevation.approvalId}/decide`, {
    personId: jordan.id,
    decision: "approved",
  });
  await api("POST", `/api/v1/elevations/${elevation.id}/sync`);
  console.log("elevations: 1 requested, approved, and granted (owner notified)");

  // --- Archive one machine ---------------------------------------------------
  // NOT going through the real POST .../archive endpoint here: it calls
  // ProvisioningServiceTag.archive(machineId), and the fake provisioning
  // adapter only knows about machines it created itself via its own
  // create() (an in-memory Map, keyed by machineId). The real machines API
  // (unit 2) never calls ProvisioningService at all when it inserts a row —
  // no unit wired machine creation to the reconcile loop that would
  // normally register a machine with the provisioning adapter. So a machine
  // created through the real HTTP API 404s ("unknown machineId") the moment
  // anything tries to provision-archive it. This is a genuine integration
  // gap between units 1 and 2, not something this seed script should paper
  // over silently — flagged here and in the follow-up report. Standing in
  // for it: insert exactly what a successful archive would have produced
  // (snapshot row + machine state flip), matching createSnapshot's own field
  // set in domain/archive/snapshot.ts.
  const retentionDays = 30;
  const archivedAt = new Date();
  const expiresAt = new Date(archivedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  await db.insert(schema.snapshots).values({
    orgId: org.id,
    machineId: worker.id,
    trigger: "archive",
    region: "eastus",
    sizeBytes: 42_949_672_960,
    containsData: true,
    containsConfig: true,
    legalHold: false,
    retentionDays,
    createdAt: archivedAt,
    expiresAt,
  });
  await db
    .update(schema.machines)
    .set({ state: "archived_restorable", archivedAt })
    .where(eq(schema.machines.id, worker.id));
  console.log("archive: worker-04 archived (1 snapshot, seeded directly — see comment above)");

  console.log("\nDone. orgId for manual API/browser poking:");
  console.log(org.id);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
