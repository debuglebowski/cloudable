import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eConfig } from "./config";
import { connect, schema } from "./db";

/** Fixed local-dev-only password, same idea as seed-demo.ts's `DEMO_PASSWORD` — not a real credential. */
export const E2E_PASSWORD = "cloudable-e2e-2026!";

export const E2E_USER_FILE = join(tmpdir(), "cloudable-e2e-user.json");

export interface E2eUser {
  readonly orgId: string;
  readonly personId: string;
  readonly authUserId: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Creates one throwaway org + person + real BetterAuth login for this test
 * run, rather than reusing `seed-demo.ts`'s fixed-id demo org: that script
 * isn't idempotent (fails if its fixed org id already exists, see its own
 * comment) and its `--reset` truncates tables no e2e run should ever touch
 * on a developer's local database. A fresh, randomly-named org/email per
 * run means this can never collide with real dev data or a previous run
 * that didn't get torn down cleanly.
 */
export default async function globalSetup() {
  const { client, db } = connect();
  try {
    const [org] = await db
      .insert(schema.orgs)
      .values({ name: `e2e-${randomUUID()}` })
      .returning();
    if (!org) throw new Error("failed to insert e2e org");

    const email = `e2e-${randomUUID()}@cloudable.test`;
    const [person] = await db
      .insert(schema.people)
      .values({ orgId: org.id, email, source: "manual", active: true, role: "owner" })
      .returning();
    if (!person) throw new Error("failed to insert e2e person");

    // Real BetterAuth sign-up (same endpoint the login page itself posts to)
    // — an e2e login test must exercise the real credential path, not a
    // hand-inserted `auth_user` row that BetterAuth's own password hashing
    // never touched. `Origin` matches `auth.ts`'s `trustedOrigins` check,
    // same as `seed-demo.ts`'s `signInAs`.
    const res = await fetch(`${e2eConfig.controlPlaneUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: e2eConfig.consoleUrl },
      body: JSON.stringify({ email, password: E2E_PASSWORD, name: "E2E Test User" }),
    });
    if (!res.ok) {
      throw new Error(`e2e sign-up failed for ${email} -> ${res.status}: ${await res.text()}`);
    }
    const { user } = (await res.json()) as { user: { id: string } };

    const e2eUser: E2eUser = {
      orgId: org.id,
      personId: person.id,
      authUserId: user.id,
      email,
      password: E2E_PASSWORD,
    };
    await writeFile(E2E_USER_FILE, JSON.stringify(e2eUser), "utf8");
  } finally {
    await client.end();
  }
}
