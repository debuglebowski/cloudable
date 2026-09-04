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
import { eq, getTableName, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../src/config";

const API_BASE = process.env.SEED_API_BASE ?? `http://localhost:${config.port}`;
const RESET = process.argv.includes("--reset") || process.env.SEED_RESET === "1";

/**
 * Every domain table this script (or the real API calls it makes) can write
 * to — deliberately an explicit array, not a wildcard walk of the schema
 * package's exports, matching that package's own "append-only, reviewable"
 * convention (see `packages/schema/src/index.ts`'s header comment). Most of
 * these have no DB-level foreign key back to `orgs`/`people`/`machines` (only
 * a handful do — see `approvalDecisions`/`restoreRequests`), so `CASCADE`
 * alone would not reach them: this list is load-bearing, not decorative. Add
 * a new domain table here when it's added to `packages/schema/src/index.ts`.
 *
 * Deliberately excludes `authUser`/`authSession`/`authAccount`/
 * `authVerification` — those are real BetterAuth logins, not demo data, and
 * `--reset` should never sign a developer out of their own local session.
 */
const RESET_TABLES = [
  schema.orgs,
  schema.people,
  schema.machines,
  schema.machinePackages,
  schema.approvals,
  schema.approvalDecisions,
  schema.certificates,
  schema.sessions,
  schema.snapshots,
  schema.integrations,
  schema.elevations,
  schema.complianceFindingState,
  schema.controlOverrides,
  schema.secretBindings,
  schema.upgradeAttempts,
  schema.notifications,
  schema.restoreRequests,
  schema.events,
  schema.accessCommandRecorded,
  schema.settingValues,
];

/**
 * `cookie`, when given, is sent as the request's `Cookie` header — see
 * `signInAs` below for why this is needed at all now: `machines`,
 * `approvals`, `elevations`, and `archive` are wired to real session auth
 * (`CurrentUserAuthentication`, `http/middleware/auth.ts`), and derive the
 * acting org/person from that session, not from the payload. `access`
 * (certificates/sessions) is the one group still unauthenticated — those
 * calls pass no cookie and keep taking `orgId`/`personId` on the wire.
 */
async function api<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

// Real, local-dev-only password shared by every seeded demo account — none
// of these are real credentials, and BetterAuth requires *some* password.
const DEMO_PASSWORD = "cloudable-demo-2026!";

/**
 * Signs a demo person up (first run) or in (every run after — `--reset`
 * deliberately preserves `auth_user`, see `RESET_TABLES`'s comment, so these
 * accounts persist across reseeds) via the real BetterAuth endpoints
 * (`ee50414`'s `/api/auth/*` mount), and returns the `Cookie` header value
 * carrying their session. `Origin` matches `auth.ts`'s `trustedOrigins`
 * check — confirmed needed by hand against the running server; omitting it
 * doesn't reject this call, but matching the real console's origin is the
 * correct thing to send regardless.
 */
async function signInAs(email: string, name: string): Promise<string> {
  const authHeaders = { "Content-Type": "application/json", Origin: config.consoleOrigin };
  const signUpRes = await fetch(`${API_BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ email, password: DEMO_PASSWORD, name }),
  });
  const res = signUpRes.ok
    ? signUpRes
    : await fetch(`${API_BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ email, password: DEMO_PASSWORD }),
      });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sign-in failed for ${email} -> ${res.status}: ${text}`);
  }
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0] ?? c);
  if (cookies.length === 0) throw new Error(`sign-in for ${email} returned no session cookie`);
  return cookies.join("; ");
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

const pgClient = postgres(config.databaseUrl);
const db = drizzle(pgClient, { schema });

// Fixed, not random — matches `apps/console/src/lib/current-org.ts`'s
// CURRENT_ORG_ID, so the console needs zero configuration to find this
// org's data after a reseed.
const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";
// Matches `apps/console/src/lib/current-person.ts`'s CURRENT_PERSON_ID —
// see that file's doc comment. Assigned to Jordan below.
const CURRENT_PERSON_ID = "00000000-0000-0000-0000-000000000002";

async function main() {
  console.log(`Seeding demo data against ${API_BASE} ...`);

  // Fail fast with a clear diagnosis — otherwise the first real POST call
  // below throws a raw connection-refused error after the org/people rows
  // (inserted directly via Drizzle, not through the API) are already in.
  const healthy = await fetch(`${API_BASE}/api/v1/health`).then(
    (res) => res.ok,
    () => false,
  );
  if (!healthy) {
    throw new Error(
      `control-plane not reachable at ${API_BASE} — start it with 'bun run dev:control-plane' first.`,
    );
  }

  if (RESET) {
    const quotedNames = RESET_TABLES.map((t) => `"${getTableName(t)}"`).join(", ");
    await db.execute(sql.raw(`truncate table ${quotedNames} cascade`));
    console.log(`reset: truncated ${RESET_TABLES.length} demo tables (real logins preserved)`);
  }

  const [existing] = await db
    .select({ id: schema.orgs.id })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, DEMO_ORG_ID))
    .limit(1);
  if (existing) {
    throw new Error(
      `Demo org ${DEMO_ORG_ID} already exists — this script is not idempotent (fixed id, real business-logic side effects). Re-run with '--reset' (or SEED_RESET=1) to wipe demo data first.`,
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
    // unread owner notification with zero further configuration.
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

  // Real BetterAuth sessions for each demo person — every call below that
  // hits an authenticated endpoint carries the acting person's own cookie,
  // so approvals/elevations/etc. are attributed the way the narrative below
  // intends, not all to one fixed identity (see `signInAs`'s doc comment).
  const [priyaCookie, marcusCookie, elenaCookie, jordanCookie, samCookie] = await Promise.all([
    signInAs(priya.email, "Priya Natarajan"),
    signInAs(marcus.email, "Marcus Webb"),
    signInAs(elena.email, "Elena Ruiz"),
    signInAs(jordan.email, "Jordan Blake"),
    signInAs(sam.email, "Sam Okafor"),
  ]);
  console.log("people: signed in as all 5 (real BetterAuth sessions)");

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
    // `orgId` is gone from this payload too (derived from the caller's
    // session) — see `MachinesGroup`'s handler. Created as Priya (the org's
    // one seeded "owner"-role person); nothing here requires the creator to
    // also be the machine's owner.
    const created = await api<{ id: string }>(
      "POST",
      "/api/v1/machines",
      {
        name: m.name,
        region: m.region,
        sizeSku: m.sizeSku,
        image: m.image,
        ownerPersonId: m.owner.id,
      },
      priyaCookie,
    );
    machines.push({ id: created.id, name: m.name, ownerPersonId: m.owner.id });
  }
  // `POST /api/v1/machines` now calls `ProvisioningService.create` itself
  // (see `MachineService.create`), settling each row to `running` (or
  // `error`, against whichever adapter this control-plane was booted with)
  // synchronously — no manual state flip needed here anymore.
  console.log(`machines: ${machines.length} created`);
  const [dbProd, buildRunner, analytics, staging, worker] = machines;
  if (!dbProd || !buildRunner || !analytics || !staging || !worker) {
    throw new Error("failed to create machines");
  }

  // --- Approvals (real POST /api/v1/approvals, some decided via decide) ----
  // `orgId`/`requestedByPersonId`/`personId` are gone from these payloads —
  // derived from whichever demo person's cookie makes the call (see
  // `ApprovalsGroup`'s own comment in `routes/approvals.ts`).
  const pendingBreakGlass = await api<{ id: string }>(
    "POST",
    "/api/v1/approvals",
    {
      actionType: "break_glass",
      targetMachineId: dbProd.id,
      reason: "Customer P1 — production database locked, need shell to unblock a stuck migration.",
    },
    priyaCookie,
  );
  await api(
    "POST",
    `/api/v1/approvals/${pendingBreakGlass.id}/decide`,
    { decision: "approved" },
    elenaCookie,
  );

  await api(
    "POST",
    "/api/v1/approvals",
    {
      actionType: "snapshot_restore",
      targetMachineId: buildRunner.id,
      reason: "Restore last night's snapshot after a bad config push wiped local state.",
    },
    marcusCookie,
  );

  const restoreToDeny = await api<{ id: string }>(
    "POST",
    "/api/v1/approvals",
    {
      actionType: "snapshot_restore",
      targetMachineId: staging.id,
      reason: "Restore full config and secret bindings to a two-week-old snapshot.",
    },
    jordanCookie,
  );
  await api(
    "POST",
    `/api/v1/approvals/${restoreToDeny.id}/decide`,
    {
      decision: "rejected",
      reason: "Secret bindings are stale — re-provision the machine instead of restoring them.",
    },
    priyaCookie,
  );

  await api(
    "POST",
    "/api/v1/approvals",
    {
      actionType: "admin_access",
      targetMachineId: analytics.id,
      reason: "Owner is on leave; need to pull a log file for the SOC2 auditor's sample request.",
    },
    elenaCookie,
  );
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
  // NOT own — a self-owned target is rejected with SelfOwnedMachineError, so
  // this has to be someone other than staging's owner.
  // `personId` is gone from this payload too — Priya requesting it is now
  // expressed by calling as her (priyaCookie), not a client-supplied id.
  const elevation = await api<{ id: string; approvalId: string | null }>(
    "POST",
    "/api/v1/elevations",
    {
      machineId: staging.id,
      level: "file_recovery",
      reason: "Pulling a log file for the SOC2 auditor's sample request while Jordan is out.",
    },
    priyaCookie,
  );
  // Decided and synced to granted (rather than left pending) so the demo
  // also exercises the real owner-notification flow — Jordan (staging's
  // owner, and this build's fixed
  // CURRENT_PERSON_ID — see apps/console/src/lib/current-person.ts) has one
  // real unread notification after this reseed.
  if (!elevation.approvalId) throw new Error("expected the elevation to have an approvalId");
  await api(
    "POST",
    `/api/v1/approvals/${elevation.approvalId}/decide`,
    { decision: "approved" },
    jordanCookie,
  );
  await api("POST", `/api/v1/elevations/${elevation.id}/sync`, undefined, jordanCookie);
  console.log("elevations: 1 requested, approved, and granted (owner notified)");

  // --- Archive one machine ---------------------------------------------------
  // Goes through the real POST .../archive endpoint now — `MachineService.create`
  // (above) registers every machine with `ProvisioningService` right away, so
  // a machine created through the real HTTP API is no longer invisible to
  // archive/reconcile/upgrade (previously a genuine integration gap; see
  // `MachineService.create`'s own comment). Archived as Sam, worker-04's owner.
  await api("POST", `/api/v1/archive/machines/${worker.id}/archive`, {}, samCookie);
  console.log("archive: worker-04 archived (1 snapshot, via the real archive endpoint)");

  // --- Reconcile real logins to `people` -----------------------------------
  // The bridge from a BetterAuth login to a `people` row is an email match,
  // not a foreign key (`http/middleware/auth.ts`'s `CurrentUserAuthentication`
  // — see that file's doc comment). Nothing above ever creates a `people` row
  // for whoever is actually signed in locally, only for the fixed demo
  // emails — so without this, every authenticated console query 500s
  // (`AuthenticationRequired: no_matching_person`) for a real developer login
  // until someone notices and hand-inserts a row. Do it here, every run, so
  // that can't happen again.
  const logins = await db.select({ email: schema.authUser.email }).from(schema.authUser);
  const seededEmails = new Set(people.map((p) => p.email));
  const unprovisioned = logins.filter((u) => !seededEmails.has(u.email));
  if (unprovisioned.length > 0) {
    await db.insert(schema.people).values(
      unprovisioned.map((u) => ({
        orgId: org.id,
        email: u.email,
        source: "manual" as const,
        active: true,
        role: "owner",
      })),
    );
    console.log(
      `people (real logins): provisioned ${unprovisioned.map((u) => u.email).join(", ")}`,
    );
  }

  console.log("\nDone. orgId for manual API/browser poking:");
  console.log(org.id);

  await pgClient.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
