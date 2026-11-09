import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { events, orgs, people } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { type IsolatedDb, createIsolatedDb } from "../test-support/isolated-db";
import { isDbReachable } from "../testing/db-reachable";

/**
 * Real SAML through BetterAuth's real assertion-consumer endpoint: a control plane configured
 * with a test identity provider (a fresh RSA key and self-signed certificate), real signed XML,
 * the real `@better-auth/sso` checks, and Cloudable's own on top. Each run of
 * `saml-acs.harness.ts` is a separate process, so the replay case is a genuine restart.
 *
 * Proves what the unit-level tests cannot: that a signed assertion issued for an earlier request
 * cannot be re-wrapped in a new envelope, that a stale or unbound or unsigned or tampered
 * assertion grants nothing, that the role evidence is dated by the signed IssueInstant, and that
 * replaying an accepted response after a restart is refused.
 */
const BASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const reachable = await isDbReachable(BASE_URL);
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

const CLAIM = "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";
const HARNESS = path.join(import.meta.dir, "saml-acs.harness.ts");

describe.skipIf(!reachable || !hasOpenssl)("SAML assertions through the real ACS endpoint", () => {
  let iso: IsolatedDb;
  let dir: string;
  let keyPem: string;
  let certPem: string;
  let personId: string;
  let orgId: string;
  const email = `ana-${crypto.randomUUID().slice(0, 8)}@example.com`;

  beforeAll(async () => {
    iso = await createIsolatedDb(BASE_URL);
    dir = mkdtempSync(path.join(tmpdir(), "cloudable-saml-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=test-idp",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    keyPem = readFileSync(path.join(dir, "key.pem"), "utf8");
    certPem = readFileSync(path.join(dir, "cert.pem"), "utf8");
    const [org] = await iso.db.insert(orgs).values({ name: "saml" }).returning();
    if (!org) throw new Error("org");
    orgId = org.id;
    const [person] = await iso.db
      .insert(people)
      .values({ orgId, email, role: "member" })
      .returning();
    if (!person) throw new Error("person");
    personId = person.id;
  });

  afterAll(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    await iso?.drop();
  });

  const run = (steps: unknown[]) => {
    const certBody = certPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const result = spawnSync("bun", [HARNESS], {
      env: {
        ...process.env,
        DATABASE_URL: iso.url,
        BETTER_AUTH_URL: "http://localhost:4799",
        BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth-0123456789",
        CONSOLE_ORIGIN: "http://localhost:4799",
        IDP_METADATA_URL: "https://idp.example/metadata",
        IDP_SAML_CONFIG: JSON.stringify({
          entityId: "https://idp.example/entity",
          ssoUrl: "https://idp.example/sso",
          sloUrl: "https://idp.example/slo",
          emailDomains: "example.com",
          certs: [certBody],
        }),
        IDP_ROLES_ENABLED: "true",
        IDP_ROLE_CLAIM: CLAIM,
        IDP_ROLE_MAPPING: JSON.stringify({
          "Cloudable.Admin": ["admin"],
          "Cloudable.Member": ["member"],
          "Cloudable.Approver": ["approver"],
        }),
        PASSWORD_SIGN_IN: "",
        HARNESS_KEY_PEM: keyPem,
        HARNESS_CERT_PEM: certPem,
        HARNESS_STEPS: JSON.stringify(steps),
      },
      cwd: path.resolve(import.meta.dir, "../.."),
      encoding: "utf8",
      timeout: 60_000,
    });
    const line = result.stdout.split("\n").find((l) => l.startsWith("HARNESS_RESULT "));
    if (process.env.SHOW_HARNESS) console.error(line?.replace(/"body":"[^"]*",?/g, ""));
    if (!line) throw new Error(`harness failed:\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(line.slice("HARNESS_RESULT ".length)) as Record<
      string,
      {
        status: number;
        error: string | null;
        sessionCookie: boolean;
        body: string;
        issueInstant: number;
      }
    >;
  };

  const person = async () => {
    const [row] = await iso.db.select().from(people).where(eq(people.id, personId));
    if (!row) throw new Error("person");
    return row;
  };

  test("valid, then every forged or stale variant refused, then replay refused after restart", async () => {
    const first = run([
      { kind: "post", name: "valid", email, roles: ["Cloudable.Admin"], variant: "valid" },
      {
        kind: "post",
        name: "rewrapped",
        email,
        roles: ["Cloudable.Admin", "Cloudable.Approver"],
        variant: "rewrapped_old_assertion",
      },
      {
        kind: "post",
        name: "stale",
        email,
        roles: ["Cloudable.Admin", "Cloudable.Approver"],
        variant: "stale_issue_instant",
      },
      {
        kind: "post",
        name: "unsigned",
        email,
        roles: ["Cloudable.Admin", "Cloudable.Approver"],
        variant: "unsigned_assertion",
      },
      {
        kind: "post",
        name: "tampered",
        email,
        roles: ["Cloudable.Member"],
        variant: "tampered_after_signing",
      },
      {
        kind: "post",
        name: "unbound",
        email,
        roles: ["Cloudable.Admin", "Cloudable.Approver"],
        variant: "no_scd_in_response_to",
      },
    ]);

    // The real thing works: signed, bound, fresh.
    expect(first.valid?.error).toBeNull();
    expect(first.valid?.sessionCookie).toBe(true);
    const afterValid = await person();
    expect(afterValid.role).toBe("admin");
    expect(afterValid.approver).toBe(false);
    // Dated by the assertion's own signed IssueInstant.
    expect(afterValid.idpRolesVerifiedAt?.getTime()).toBe(first.valid?.issueInstant);

    // Every forged or stale variant is refused, with no session and no change.
    for (const name of ["rewrapped", "stale", "unsigned", "tampered", "unbound"]) {
      expect({ name, error: first[name]?.error }).not.toEqual({ name, error: null });
      expect(first[name]?.sessionCookie).toBe(false);
    }
    // The two the plugin alone would have accepted are refused by Cloudable's own check.
    expect(first.rewrapped?.error).toBe("saml_assertion_rejected");
    expect(first.stale?.error).toBe("saml_assertion_rejected");
    expect(first.unbound?.error).toBe("saml_assertion_rejected");
    const afterForgeries = await person();
    expect(afterForgeries.role).toBe("admin");
    expect(afterForgeries.approver).toBe(false);
    expect(afterForgeries.idpRolesVerifiedAt?.getTime()).toBe(first.valid?.issueInstant);

    // A restart (a new process), then the accepted response posted again: refused.
    const second = run([
      { kind: "replay", name: "replay", body: first.valid?.body ?? "" },
      { kind: "post", name: "no_role", email, roles: [], variant: "valid" },
    ]);
    expect(second.replay?.error).not.toBeNull();
    expect(second.replay?.sessionCookie).toBe(false);

    // A genuine assertion with no role: denied, demoted, recorded.
    expect(second.no_role?.error).toBe("no_mapped_role");
    expect(second.no_role?.sessionCookie).toBe(false);
    const denied = await person();
    expect(denied.role).toBe("member");
    expect(denied.idpRolesVerifiedAt).toBeNull();
    const deniedEvents = await iso.db
      .select()
      .from(events)
      .where(and(eq(events.orgId, orgId), eq(events.type, "idp_roles.denied")));
    expect(deniedEvents).toHaveLength(1);
  }, 120_000);
});
