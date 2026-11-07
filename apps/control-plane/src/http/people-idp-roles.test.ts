import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as schema from "@cloudable/schema";
import { events, orgs, people } from "@cloudable/schema";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { Layer } from "effect";
import postgres from "postgres";
import { config } from "../config";
import type { IdpRolesConfig } from "../idp-roles/config";
import { buildAppLive } from "../layers";
import { issueCliToken } from "../services/CliToken";
import { FakeProvisioningServiceLive } from "../services/ProvisioningService.fake";
import { FakeSecretsProviderLive } from "../services/SecretsProvider.fake";
import { LocalSignerLive } from "../services/Signer.local";
import { isDbReachable } from "../testing/db-reachable";
import { ApiLive } from "./api-live";
import { ROLES_MANAGED_BY_IDP } from "./handlers/people";

/**
 * In-tool role changes through the real people handlers, with roles from the IdP off (the
 * default, unchanged) and on (refused, with the message). The CLI and the console both go
 * through these endpoints.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const postgresReachable = await isDbReachable(DATABASE_URL);

const IDP_ROLES: IdpRolesConfig = {
  claim: "roles",
  mapping: { "Cloudable.Admin": "admin" },
  unmapped: "deny",
};

const setMode = (value: IdpRolesConfig | null) => {
  (config as { idpRoles: IdpRolesConfig | null }).idpRoles = value;
};

describe.skipIf(!postgresReachable)("people API and roles from the IdP (requires Postgres)", () => {
  const sql = postgres(DATABASE_URL, { max: 2 });
  const db = drizzle(sql, { schema });
  const orgIds: string[] = [];
  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(ApiLive, HttpServer.layerContext).pipe(
      Layer.provide(
        buildAppLive({
          provisioning: FakeProvisioningServiceLive,
          signer: LocalSignerLive,
          secrets: FakeSecretsProviderLive,
        }),
      ),
    ),
  );
  const original = config.idpRoles;

  afterEach(() => setMode(original));
  afterAll(async () => {
    await dispose();
    if (orgIds.length > 0) {
      await db.delete(events).where(inArray(events.orgId, orgIds));
      await db.delete(people).where(inArray(people.orgId, orgIds));
      await db.delete(orgs).where(inArray(orgs.id, orgIds));
    }
    await sql.end();
  });

  const seed = async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: `people-idp-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("org insert failed");
    orgIds.push(org.id);
    const person = async (role: string) => {
      const [row] = await db
        .insert(people)
        .values({ orgId: org.id, email: `${crypto.randomUUID()}@example.com`, role })
        .returning();
      if (!row) throw new Error("person insert failed");
      return row.id;
    };
    const admin = await person("owner");
    const member = await person("member");
    return { admin, member, token: issueCliToken({ personId: admin }) };
  };

  const call = async (token: string, method: string, path: string, body: unknown) => {
    const response = await handler(
      new Request(`http://test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const roleOf = async (personId: string) => {
    const [row] = await db.select().from(people).where(eq(people.id, personId));
    return { role: row?.role, approver: row?.approver };
  };

  test("mode off: an admin changes roles as before", async () => {
    setMode(null);
    const f = await seed();
    const res = await call(f.token, "PATCH", `/api/v1/people/${f.member}`, {
      role: "admin",
      approver: true,
    });
    expect(res.status).toBe(200);
    expect(await roleOf(f.member)).toEqual({ role: "admin", approver: true });

    const created = await call(f.token, "POST", "/api/v1/people", {
      email: `${crypto.randomUUID()}@example.com`,
      role: "admin",
    });
    expect(created.status).toBe(201);
    expect(created.body.role).toBe("admin");
  });

  test("mode on: role and approver changes are refused with the message, and logged", async () => {
    setMode(IDP_ROLES);
    const f = await seed();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const patch of [{ role: "admin" }, { approver: true }, { role: "member" }]) {
        const res = await call(f.token, "PATCH", `/api/v1/people/${f.member}`, patch);
        expect(res.status).toBe(403);
        expect(res.body.reason).toBe(ROLES_MANAGED_BY_IDP);
      }
      const created = await call(f.token, "POST", "/api/v1/people", {
        email: `${crypto.randomUUID()}@example.com`,
        role: "admin",
      });
      expect(created.status).toBe(403);
      expect(created.body.reason).toBe(ROLES_MANAGED_BY_IDP);

      const logged = warn.mock.calls.map((args) => String(args[0]));
      expect(logged.filter((l) => l.includes("refused in-tool role change")).length).toBe(4);
    } finally {
      warn.mockRestore();
    }
    expect(await roleOf(f.member)).toEqual({ role: "member", approver: false });
  });

  test("mode on: adding a member and changing an email still work", async () => {
    setMode(IDP_ROLES);
    const f = await seed();
    const created = await call(f.token, "POST", "/api/v1/people", {
      email: `${crypto.randomUUID()}@example.com`,
      role: "member",
    });
    expect(created.status).toBe(201);
    const email = `${crypto.randomUUID()}@example.com`;
    const updated = await call(f.token, "PATCH", `/api/v1/people/${f.member}`, { email });
    expect(updated.status).toBe(200);
    expect(updated.body.email).toBe(email);
  });
});
