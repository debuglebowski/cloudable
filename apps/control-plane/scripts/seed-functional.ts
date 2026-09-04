#!/usr/bin/env bun
/**
 * Minimal seed for testing real infra end-to-end — real docker containers,
 * real agent attestation/poll loop, real access sessions — as opposed to
 * `seed-demo.ts`'s rich narrative dataset (5 people, 6 machines in
 * hand-picked states, approvals pre-decided in every status), which exists
 * to make the console UI look populated for screenshots/demos, not to back
 * anything with a real running process.
 *
 * Creates only the org + one owner person, using the exact same fixed ids
 * `apps/console/src/lib/current-org.ts`/`current-person.ts` assume — so the
 * console needs zero reconfiguration, same convention as `seed-demo.ts`.
 * Mutually exclusive with that script's dataset (same org id): run one or
 * the other, `--reset` between switches.
 *
 * Enables the "docker" provider for the seeded org (`POST /api/v1/
 * integrations`, `kind: "cloud"`) so a machine you create with
 * `provider: "docker"` next gets a real container. Everything else — machines, approvals,
 * elevations, access sessions — is deliberately left for you to create
 * live through the console/CLI: pre-seeding those would just be testing
 * the seed script's fabricated data again, not the real flow.
 *
 * Usage: control-plane must already be running (bun run dev:control-plane),
 * then from the repo root: bun run --cwd apps/control-plane seed:functional
 * Add --reset (or SEED_RESET=1) to wipe a previous run's data first — this
 * also removes any leftover `cloudable-machine-*` docker containers.
 */
import * as schema from "@cloudable/schema";
import { eq, getTableName, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../src/config";

const API_BASE = process.env.SEED_API_BASE ?? `http://localhost:${config.port}`;
const RESET = process.argv.includes("--reset") || process.env.SEED_RESET === "1";

// Same fixed ids `apps/console/src/lib/current-org.ts`/`current-person.ts` assume —
// mirrors `seed-demo.ts`'s own convention so the console needs zero reconfiguration.
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const PERSON_ID = "00000000-0000-0000-0000-000000000002";
const OWNER_EMAIL = "owner@functional.local";
const OWNER_NAME = "Functional Test Owner";

// Real, local-dev-only password — none of these are real credentials, and
// BetterAuth requires *some* password. Log in with this at localhost:5180
// if you want to drive the console as this seed's owner.
const PASSWORD = "cloudable-functional-2026!";

/** Same table list as `seed-demo.ts`'s `RESET_TABLES` — both scripts write into (or the
 * console writes into on your behalf against) the same schema, so `--reset` here needs
 * to clear everything a prior functional-testing round could have accumulated (machines,
 * approvals, access sessions, ...), not just the two rows this script inserts directly.
 * Deliberately excludes `authUser`/`authSession`/`authAccount`/`authVerification` — real
 * BetterAuth logins, not seed data; `--reset` should never sign you out of your own
 * local session. */
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

/** Signs up (first run) or in (every run after — `--reset` preserves `auth_user`, see
 * `RESET_TABLES`) via the real BetterAuth endpoints, returning the session `Cookie`
 * header — same mechanism as `seed-demo.ts`'s `signInAs`. */
async function signInAs(email: string, name: string): Promise<string> {
  const authHeaders = { "Content-Type": "application/json", Origin: config.consoleOrigin };
  const signUpRes = await fetch(`${API_BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  const res = signUpRes.ok
    ? signUpRes
    : await fetch(`${API_BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ email, password: PASSWORD }),
      });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sign-in failed for ${email} -> ${res.status}: ${text}`);
  }
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0] ?? c);
  if (cookies.length === 0) throw new Error(`sign-in for ${email} returned no session cookie`);
  return cookies.join("; ");
}

/** Best-effort cleanup of a prior functional-testing round's containers — `--reset`
 * truncates the `machines` rows but has no way to reach into Docker itself, so without
 * this a reseed leaves orphaned `cloudable-machine-*` containers behind. */
async function removeLeftoverContainers(): Promise<void> {
  const list = Bun.spawn(["docker", "ps", "-aq", "--filter", "name=cloudable-machine-"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const ids = (await new Response(list.stdout).text()).trim().split("\n").filter(Boolean);
  await list.exited;
  if (ids.length === 0) return;
  await Bun.spawn(["docker", "rm", "-f", ...ids], { stdout: "ignore", stderr: "ignore" }).exited;
  console.log(`reset: removed ${ids.length} leftover cloudable-machine-* container(s)`);
}

const pgClient = postgres(config.databaseUrl);
const db = drizzle(pgClient, { schema });

async function main() {
  console.log(`Seeding functional-test data against ${API_BASE} ...`);

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
    console.log(`reset: truncated ${RESET_TABLES.length} tables (real logins preserved)`);
    await removeLeftoverContainers();
  }

  const [existing] = await db
    .select({ id: schema.orgs.id })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, ORG_ID))
    .limit(1);
  if (existing) {
    throw new Error(
      `Org ${ORG_ID} already exists — this script (like seed-demo.ts) is not idempotent and shares that same fixed org id. Re-run with '--reset' (or SEED_RESET=1) first.`,
    );
  }

  await db.insert(schema.orgs).values({ id: ORG_ID, name: "Functional Test Org" });
  await db.insert(schema.people).values({
    id: PERSON_ID,
    orgId: ORG_ID,
    email: OWNER_EMAIL,
    source: "manual",
    active: true,
    role: "owner",
  });
  console.log(`org + owner person created (${OWNER_EMAIL})`);

  const cookie = await signInAs(OWNER_EMAIL, OWNER_NAME);

  // Same bridge-real-logins step as `seed-demo.ts`: without it, whichever real
  // BetterAuth login you're actually using in the browser (e.g. a personal dev
  // account) has no matching `people` row, and every authenticated console
  // query 500s (`AuthenticationRequired: no_matching_person`).
  const logins = await db.select({ email: schema.authUser.email }).from(schema.authUser);
  const unprovisioned = logins.filter((u) => u.email !== OWNER_EMAIL);
  if (unprovisioned.length > 0) {
    await db.insert(schema.people).values(
      unprovisioned.map((u) => ({
        orgId: ORG_ID,
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

  await api(
    "POST",
    "/api/v1/integrations",
    { kind: "cloud", provider: "docker", identifier: "Docker", config: { provider: "docker" } },
    cookie,
  ).catch((cause) => {
    throw new Error(`couldn't enable the docker provider for the seeded org\n${cause}`);
  });
  console.log("provider: enabled docker for the seeded org");

  console.log("\nDone. Sign in at the console with:");
  console.log(`  email:    ${OWNER_EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`orgId: ${ORG_ID}`);
  console.log("\nCreate a machine through the console (or POST /api/v1/machines) to get a real");
  console.log(
    'docker container — image must be "ubuntu-XX.YY" (see ProvisioningService.docker.ts).',
  );

  await pgClient.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
