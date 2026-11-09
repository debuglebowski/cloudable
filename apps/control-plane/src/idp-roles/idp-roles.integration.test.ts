import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import {
  events,
  authSession,
  authUser,
  certificates,
  idpRoleMode,
  machines,
  orgs,
  people,
  sessions,
} from "@cloudable/schema";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import {
  type AcceptanceObservation,
  type AcceptanceScenario,
  runAdapterAcceptance,
} from "@normain/idp-role-contract/fixtures";
import { APIError } from "better-auth";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { CONFIGURED_IDP_PROVIDER_ID, config } from "../config";
import { DbLive } from "../db/layer";
import { ApiLive } from "../http/api-live";
import { buildAppLive } from "../layers";
import { issueCliAuthCode } from "../services/CliAuthCode";
import { issueCliToken } from "../services/CliToken";
import { EventBus } from "../services/EventBus";
import { FakeProvisioningServiceLive } from "../services/ProvisioningService.fake";
import { FakeSecretsProviderLive } from "../services/SecretsProvider.fake";
import { LocalSignerLive } from "../services/Signer.local";
import { AgentSessionToken } from "../services/attestation/AgentSessionToken";
import { type IsolatedDb, createIsolatedDb } from "../test-support/isolated-db";
import { isDbReachable } from "../testing/db-reachable";
import { TunnelRegistry } from "../tunnel/registry";
import { TunnelRelay, closeSessionsWithLapsedAuthorization } from "../tunnel/relay";
import { TunnelServer } from "../tunnel/server";
import { TunnelSignal } from "../tunnel/signal";
import {
  MODE_ROW_ID,
  readModeRow,
  reconcileActivation,
  resetActivationForTest,
} from "./activation";
import { type IdpRolesConfig, readIdpRolesConfig } from "./config";
import { ROLES_MANAGED_BY_IDP, ROLES_MANAGED_HTTP_STATUS, ROLES_MANAGED_MESSAGE } from "./contract";
import { type AssertionFacts, runWithAssertionFacts } from "./saml-assertion";
import { IDP_ROLE_CLAIM_FIELD, idpRoleProvisioning } from "./sign-in";
import { SAML_REQUEST_TTL_MS } from "./sync";

/**
 * Roles from the identity provider, end to end through Cloudable's own code: the SAML sign-in
 * hook BetterAuth calls with a verified assertion, the persisted activation, the real HTTP
 * handlers and auth middleware (CLI bearer tokens), CLI sign-in code redemption and SSH
 * certificate issue, and the tunnel sweep. The shared contract's acceptance suite
 * (`runAdapterAcceptance`) runs on top of the same harness.
 *
 * Runs in a throwaway database (`createIsolatedDb`): switching the mode on ends every console
 * session and revokes every person's credentials, deployment-wide, by design.
 *
 * What it does not cover: the SAML XML itself (signature, audience, recipient, InResponseTo,
 * replay, timestamps). Those checks are `@better-auth/sso`'s, pinned on in `auth.ts`; this starts
 * where the plugin hands over a verified assertion.
 */
const BASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const reachable = await isDbReachable(BASE_URL);

const CLAIM = "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";
const TEST_IDP = {
  providerId: CONFIGURED_IDP_PROVIDER_ID,
  entityId: "https://sts.windows.net/tenant/",
  ssoUrl: "https://login.microsoftonline.com/tenant/saml2",
  emailDomains: "example.com",
  certs: ["MIIC-fake-cert"],
};
const MANAGED = readIdpRolesConfig(
  {
    IDP_ROLES_ENABLED: "true",
    IDP_ROLE_CLAIM: CLAIM,
    IDP_ROLE_MAPPING: JSON.stringify({
      "Cloudable.Admin": ["admin"],
      "Cloudable.Member": ["member"],
      "Cloudable.Approver": ["approver"],
    }),
  },
  TEST_IDP,
) as IdpRolesConfig;
const REMAPPED = readIdpRolesConfig(
  {
    IDP_ROLES_ENABLED: "true",
    IDP_ROLE_CLAIM: CLAIM,
    IDP_ROLE_MAPPING: JSON.stringify({ "Cloudable.Admin": ["admin", "approver"] }),
  },
  TEST_IDP,
) as IdpRolesConfig;
const LOGIN_URL = "https://cloudable.example.com/login";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe.skipIf(!reachable)("roles from the identity provider (isolated Postgres)", () => {
  let iso: IsolatedDb;
  let handler: (request: Request) => Promise<Response>;
  let disposeHandler: () => Promise<void>;
  const originalUrl = config.databaseUrl;
  const originalMode = config.idpRoles;
  const logs: string[] = [];
  const spies: Array<{ mockRestore: () => void }> = [];

  const setMode = (mode: IdpRolesConfig | null) => {
    (config as { idpRoles: IdpRolesConfig | null }).idpRoles = mode;
    resetActivationForTest();
  };

  beforeAll(async () => {
    iso = await createIsolatedDb(BASE_URL);
    // Every Effect layer built from here on (`DbLive`) connects to the throwaway database.
    (config as { databaseUrl: string }).databaseUrl = iso.url;
    const web = HttpApiBuilder.toWebHandler(
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
    handler = web.handler;
    disposeHandler = web.dispose;
    const capture = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    spies.push(spyOn(console, "log").mockImplementation(capture));
    spies.push(spyOn(console, "warn").mockImplementation(capture));
  });

  afterEach(() => setMode(null));

  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await disposeHandler?.();
    (config as { databaseUrl: string }).databaseUrl = originalUrl;
    setMode(originalMode);
    await iso?.drop();
  });

  // --- harness ---------------------------------------------------------------------------

  /** Puts the persisted mode where a scenario needs it, without going through activation. */
  const forceModeRow = async (
    mode: IdpRolesConfig | null,
    activatedAt = new Date(Date.now() - 600_000),
  ) => {
    await iso.db.delete(idpRoleMode);
    await iso.db.insert(idpRoleMode).values({
      id: MODE_ROW_ID,
      enabled: mode !== null,
      configFingerprint: mode?.fingerprint ?? null,
      activatedAt: mode ? activatedAt : null,
    });
    setMode(mode);
  };

  interface Seeded {
    orgId: string;
    personId: string;
    email: string;
    authUserId: string;
    machineId: string;
  }

  /** An org with one person who already signed in once: a BetterAuth user, a console session,
   * and a running machine they own. */
  const seed = async (
    role = "member",
    over: { approver?: boolean; verifiedAt?: Date | null } = {},
  ): Promise<Seeded> => {
    const [org] = await iso.db
      .insert(orgs)
      .values({ name: `idp-${crypto.randomUUID()}` })
      .returning();
    if (!org) throw new Error("org");
    const email = `${crypto.randomUUID()}@example.com`;
    const [person] = await iso.db
      .insert(people)
      .values({
        orgId: org.id,
        email,
        role,
        approver: over.approver ?? false,
        idpRolesVerifiedAt: over.verifiedAt === undefined ? null : over.verifiedAt,
      })
      .returning();
    if (!person) throw new Error("person");
    const authUserId = crypto.randomUUID();
    const now = new Date();
    await iso.db.insert(authUser).values({
      id: authUserId,
      name: email,
      email,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await iso.db.insert(authSession).values({
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      userId: authUserId,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: now,
      updatedAt: now,
    });
    const [machine] = await iso.db
      .insert(machines)
      .values({
        orgId: org.id,
        ownerPersonId: person.id,
        name: "m",
        provider: "fake",
        region: null,
        sizeSku: "Standard_B2s",
        image: "ubuntu-24.04",
        state: "running",
      })
      .returning();
    if (!machine) throw new Error("machine");
    await tick();
    return { orgId: org.id, personId: person.id, email, authUserId, machineId: machine.id };
  };

  /** What BetterAuth's SSO plugin does after verifying an assertion: call the provisioning hook. */
  /** Facts of a fresh signed assertion answering a request, as `withAssertionFacts` reads them.
   * The XML and signature path itself is covered by `saml-acs.integration.test.ts`. */
  const freshFacts = (issuedAt = Date.now()): AssertionFacts => ({
    responseInResponseTo: "_req",
    assertionCount: 1,
    encryptedCount: 0,
    issueInstant: issuedAt,
    signedInResponseTo: ["_req"],
  });

  const signIn = async (
    who: Seeded,
    claim: unknown,
    mode = MANAGED,
    facts: AssertionFacts | null = freshFacts(),
  ) => {
    const hook = idpRoleProvisioning(iso.db, mode, LOGIN_URL);
    try {
      await runWithAssertionFacts(facts ?? undefined, () =>
        hook.provisionUser({
          user: { id: who.authUserId, email: who.email },
          userInfo: { email: who.email, [IDP_ROLE_CLAIM_FIELD]: claim },
          provider: { providerId: CONFIGURED_IDP_PROVIDER_ID },
        }),
      );
      await tick();
      return { refused: null as string | null };
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      const location = new Headers(error.headers).get("location") ?? "";
      return { refused: new URL(location).searchParams.get("error") };
    }
  };

  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await handler(
      new Request(`http://test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: response.status, body: parsed };
  };

  const me = (token: string) => call(token, "GET", "/api/v1/me");

  const personRow = async (personId: string) => {
    const [row] = await iso.db.select().from(people).where(eq(people.id, personId));
    if (!row) throw new Error("person vanished");
    return row;
  };

  const grantsOfRow = (row: { role: string; approver: boolean }) =>
    [row.role, ...(row.approver ? ["approver"] : [])].sort();

  const sessionCount = async (userId: string) =>
    (await iso.db.select().from(authSession).where(eq(authSession.userId, userId))).length;

  const auditEvents = (orgId: string, type?: string) =>
    iso.db
      .select()
      .from(events)
      .where(and(eq(events.orgId, orgId), ...(type ? [eq(events.type, type)] : [])));

  /** A machine (automation) credential, minted and verified by the real service. */
  const agentToken = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* AgentSessionToken;
        return service;
      }).pipe(Effect.provide(AgentSessionToken.Default)),
    );

  const ed25519Raw = () => {
    const { publicKey } = crypto.generateKeyPairSync("ed25519");
    return publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  };

  const redeemCode = (
    who: Seeded,
    code = issueCliAuthCode({ personId: who.personId, orgId: who.orgId }),
  ) =>
    call("unused", "POST", "/api/v1/access/certificates", {
      code,
      osUser: "cloudable",
      machineScope: "all",
      publicKeyBase64: ed25519Raw(),
    });

  // --- native behaviour ------------------------------------------------------------------

  test("mode off: roles stay Cloudable's, no freshness, local changes allowed", async () => {
    await forceModeRow(null);
    const admin = await seed("owner");
    const member = await seed("member");
    await iso.db.update(people).set({ orgId: admin.orgId }).where(eq(people.id, member.personId));
    const token = issueCliToken({ personId: admin.personId });
    expect((await me(token)).status).toBe(200);
    const patched = await call(token, "PATCH", `/api/v1/people/${member.personId}`, {
      role: "admin",
      approver: true,
    });
    expect(patched.status).toBe(200);
    expect(grantsOfRow(await personRow(member.personId))).toEqual(["admin", "approver"]);
  });

  test("grant: a verified sign-in sets role and flag, stores evidence no later than the assertion, and is audited", async () => {
    await forceModeRow(MANAGED);
    const who = await seed("member");
    const issuedAt = Date.now() - 90_000;
    expect(
      (await signIn(who, ["Cloudable.Admin", "Cloudable.Approver"], MANAGED, freshFacts(issuedAt)))
        .refused,
    ).toBeNull();
    const row = await personRow(who.personId);
    expect(grantsOfRow(row)).toEqual(["admin", "approver"]);
    // The role evidence is dated by the assertion's own signed IssueInstant, not receipt time.
    const verifiedAt = row.idpRolesVerifiedAt?.getTime() ?? 0;
    expect(verifiedAt).toBe(issuedAt);
    expect((await me(issueCliToken({ personId: who.personId }))).status).toBe(200);

    const granted = await auditEvents(who.orgId, "idp_roles.granted");
    expect(granted).toHaveLength(1);
    expect(granted[0]?.actorType).toBe("idp");
    expect(granted[0]?.payload).toMatchObject({
      service: "cloudable",
      actor: CONFIGURED_IDP_PROVIDER_ID,
      subject: who.personId,
      source: "saml",
      previousGrants: ["member"],
      newGrants: ["admin", "approver"],
      reason: "verified",
    });
    expect((await auditEvents(who.orgId, "person.role_changed")).length).toBe(1);
    expect(
      logs.some((line) => line.startsWith("[security] idp-roles {") && line.includes(who.personId)),
    ).toBe(true);

    // The same roles again: revalidated, evidence moves forward, never back.
    expect((await signIn(who, ["Cloudable.Approver", "Cloudable.Admin"])).refused).toBeNull();
    expect((await auditEvents(who.orgId, "idp_roles.revalidated")).length).toBe(1);
    expect((await personRow(who.personId)).idpRolesVerifiedAt?.getTime()).toBeGreaterThanOrEqual(
      verifiedAt,
    );
  });

  test("the hook refuses an assertion not bound to the request, too old, or older than recorded evidence", async () => {
    await forceModeRow(MANAGED);
    const who = await seed("member");
    for (const facts of [
      null,
      { ...freshFacts(), signedInResponseTo: ["_old_request"] },
      { ...freshFacts(), signedInResponseTo: [] },
      { ...freshFacts(), encryptedCount: 1 },
      { ...freshFacts(), assertionCount: 2 },
      freshFacts(Date.now() - SAML_REQUEST_TTL_MS - 1000),
      freshFacts(Date.now() + 120_000),
    ]) {
      expect((await signIn(who, "Cloudable.Admin", MANAGED, facts)).refused).toBe(
        "saml_assertion_rejected",
      );
    }
    expect((await personRow(who.personId)).role).toBe("member");
    expect(
      (await signIn(who, "Cloudable.Admin", MANAGED, freshFacts(Date.now() - 1000))).refused,
    ).toBeNull();
    expect(
      (await signIn(who, "Cloudable.Admin", MANAGED, freshFacts(Date.now() - 60_000))).refused,
    ).toBe("saml_assertion_rejected");
  });

  test("a new identity provider cannot reuse evidence from the previous one", async () => {
    await forceModeRow(null);
    const who = await seed("member");
    expect((await reconcileActivation(iso.db, MANAGED)).kind).toBe("activated");
    setMode(MANAGED);
    expect((await signIn(who, "Cloudable.Admin")).refused).toBeNull();
    const token = issueCliToken({ personId: who.personId });
    expect((await me(token)).status).toBe(200);

    const otherIdp = readIdpRolesConfig(
      {
        IDP_ROLES_ENABLED: "true",
        IDP_ROLE_CLAIM: CLAIM,
        IDP_ROLE_MAPPING: JSON.stringify({
          "Cloudable.Admin": ["admin"],
          "Cloudable.Member": ["member"],
          "Cloudable.Approver": ["approver"],
        }),
      },
      { ...TEST_IDP, entityId: "https://other-idp.example/", certs: ["MIIC-other"] },
    ) as IdpRolesConfig;
    expect(otherIdp.fingerprint).not.toBe(MANAGED.fingerprint);
    // A replica still on the old provider is fenced off as soon as the new one is persisted.
    expect((await reconcileActivation(iso.db, otherIdp)).kind).toBe("activated");
    expect((await me(token)).status).toBe(401);
    expect((await me(token)).body.reason).toBe("idp_roles_config_mismatch");
    setMode(otherIdp);
    // Under the new provider: old evidence cleared, old credentials refused.
    expect((await personRow(who.personId)).idpRolesVerifiedAt).toBeNull();
    expect((await me(token)).status).toBe(401);
    // And a sign-in under the old provider's config cannot write evidence any more.
    expect((await signIn(who, "Cloudable.Admin", MANAGED)).refused).toBe(
      "idp_roles_config_changed",
    );
    expect((await signIn(who, "Cloudable.Admin", otherIdp)).refused).toBeNull();
    expect((await me(issueCliToken({ personId: who.personId }))).status).toBe(200);
  });

  test("mixed replicas: a mode-off replica refuses everything while the persisted mode is on, and vice versa", async () => {
    await forceModeRow(MANAGED);
    const who = await seed("owner", { verifiedAt: new Date() });
    const token = issueCliToken({ personId: who.personId });
    // This replica: mode off. Persisted: on. Refused, not served unmanaged.
    setMode(null);
    const refused = await me(token);
    expect(refused.status).toBe(401);
    expect(refused.body.reason).toBe("idp_roles_config_mismatch");
    expect((await redeemCode(who)).status).toBe(403);
    // Persisted off, replica off: today's behaviour.
    await forceModeRow(null);
    expect((await me(token)).status).toBe(200);
  });

  test("an assertion issued before the current epoch or the person's last revocation counts for nothing", async () => {
    // Activated 10s ago; an assertion issued 30s ago, inside its 5 minutes, arrives now.
    await forceModeRow(MANAGED, new Date(Date.now() - 10_000));
    const who = await seed("member");
    expect(
      (await signIn(who, "Cloudable.Admin", MANAGED, freshFacts(Date.now() - 30_000))).refused,
    ).toBe("saml_assertion_rejected");
    expect((await personRow(who.personId)).role).toBe("member");
    expect(
      (await signIn(who, "Cloudable.Admin", MANAGED, freshFacts(Date.now()))).refused,
    ).toBeNull();

    // Refused at T (credentials revoked); an assertion issued before T, arriving after, grants nothing.
    const beforeDenial = Date.now();
    await tick();
    expect((await signIn(who, [])).refused).toBe("no_mapped_role");
    expect((await signIn(who, "Cloudable.Admin", MANAGED, freshFacts(beforeDenial))).refused).toBe(
      "saml_assertion_rejected",
    );
    expect((await personRow(who.personId)).role).toBe("member");
    await tick();
    expect((await signIn(who, "Cloudable.Admin")).refused).toBeNull();
  });

  test("approver alone is not a role: refused", async () => {
    await forceModeRow(MANAGED);
    const who = await seed("admin", { approver: true, verifiedAt: new Date(Date.now() - 60_000) });
    expect((await signIn(who, "Cloudable.Approver")).refused).toBe("no_mapped_role");
    expect(grantsOfRow(await personRow(who.personId))).toEqual(["member"]);
  });

  test("a sign-in under config that is no longer persisted is refused (activation fence)", async () => {
    await forceModeRow(REMAPPED);
    const who = await seed("member");
    expect((await signIn(who, "Cloudable.Admin", MANAGED)).refused).toBe(
      "idp_roles_config_changed",
    );
    expect((await personRow(who.personId)).role).toBe("member");
  });

  test("a provider other than the configured one never carries roles", async () => {
    await forceModeRow(MANAGED);
    const who = await seed("member");
    const hook = idpRoleProvisioning(iso.db, MANAGED, LOGIN_URL);
    const error = await hook
      .provisionUser({
        user: { id: who.authUserId, email: who.email },
        userInfo: { [IDP_ROLE_CLAIM_FIELD]: "Cloudable.Admin" },
        provider: { providerId: "console-registered" },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIError);
    expect((await personRow(who.personId)).role).toBe("member");
  });

  test("freshness: the deadline refuses API, CLI code redemption and live tunnels until a fresh SSO sign-in", async () => {
    await forceModeRow(MANAGED, new Date(Date.now() - 7200_000));
    const stale = new Date(Date.now() - MANAGED.intervalSec * 1000);
    const who = await seed("admin", { verifiedAt: stale });
    const token = issueCliToken({ personId: who.personId });

    const refused = await me(token);
    expect(refused.status).toBe(401);
    expect(refused.body.reason).toBe("idp_reauthentication_required");
    expect((await personRow(who.personId)).idpRolesVerifiedAt?.getTime()).toBe(stale.getTime());

    const redeemed = await redeemCode(who);
    expect(redeemed.status).toBe(403);
    expect(String(redeemed.body.message)).toContain("cloudable login");

    // An open SSH session of theirs closes on the next sweep.
    const [open] = await iso.db
      .insert(sessions)
      .values({
        orgId: who.orgId,
        machineId: who.machineId,
        personId: who.personId,
        method: "ssh",
        osUser: "cloudable",
      })
      .returning();
    const closed = await Effect.runPromise(
      closeSessionsWithLapsedAuthorization().pipe(Effect.provide(relayLayer())),
    );
    expect(closed).toBeGreaterThanOrEqual(1);
    const [after] = await iso.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, open?.id ?? ""));
    expect(after?.endedAt).not.toBeNull();

    // A fresh SSO sign-in renews it; the same token works again.
    expect((await signIn(who, "Cloudable.Admin")).refused).toBeNull();
    expect((await me(token)).status).toBe(200);
  });

  test("an SSH certificate never outlives the role evidence it was issued under", async () => {
    await forceModeRow(MANAGED);
    const who = await seed("member");
    expect((await signIn(who, "Cloudable.Member")).refused).toBeNull();
    const issued = await redeemCode(who);
    expect(issued.status).toBe(200);
    const deadline =
      ((await personRow(who.personId)).idpRolesVerifiedAt?.getTime() ?? 0) +
      MANAGED.intervalSec * 1000;
    expect(new Date(String(issued.body.expiresAt)).getTime()).toBeLessThanOrEqual(deadline);
  });

  test("a CLI sign-in code minted before revocation mints nothing after it", async () => {
    await forceModeRow(MANAGED);
    const who = await seed("member");
    expect((await signIn(who, "Cloudable.Member")).refused).toBeNull();
    const earlyCode = issueCliAuthCode({ personId: who.personId, orgId: who.orgId });
    await tick();
    expect((await signIn(who, [])).refused).toBe("no_mapped_role");
    const redeemed = await redeemCode(who, earlyCode);
    expect(redeemed.status).toBe(403);
    expect(String(redeemed.body.message)).toContain("revoked");
  });

  test("local role and approver changes are refused with 409 and audited; email and member adds still work", async () => {
    await forceModeRow(MANAGED);
    const admin = await seed("admin");
    expect((await signIn(admin, "Cloudable.Admin")).refused).toBeNull();
    const target = await seed("member");
    await iso.db.update(people).set({ orgId: admin.orgId }).where(eq(people.id, target.personId));
    const token = issueCliToken({ personId: admin.personId });

    for (const patch of [{ role: "admin" }, { approver: true }]) {
      const res = await call(token, "PATCH", `/api/v1/people/${target.personId}`, patch);
      expect(res.status).toBe(ROLES_MANAGED_HTTP_STATUS);
      expect(res.body.code).toBe(ROLES_MANAGED_BY_IDP);
      expect(res.body.message).toBe(ROLES_MANAGED_MESSAGE);
    }
    const created = await call(token, "POST", "/api/v1/people", {
      email: `${crypto.randomUUID()}@example.com`,
      role: "owner",
    });
    expect(created.status).toBe(409);
    const refusals = await auditEvents(admin.orgId, "idp_roles.local_change_refused");
    expect(refusals).toHaveLength(3);
    expect(refusals[0]?.payload).toMatchObject({ actor: admin.personId, source: "local" });

    expect(
      (
        await call(token, "POST", "/api/v1/people", {
          email: `${crypto.randomUUID()}@example.com`,
          role: "member",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(token, "PATCH", `/api/v1/people/${target.personId}`, {
          email: `${crypto.randomUUID()}@example.com`,
        })
      ).status,
    ).toBe(200);
  });

  test("activation: persisted once, idempotent across restarts, again on remap and off→on; new SSO survives", async () => {
    await forceModeRow(null);
    const who = await seed("owner", { verifiedAt: new Date() });
    const token = issueCliToken({ personId: who.personId });
    const machineCred = (await agentToken()).mint({ orgId: who.orgId, machineId: who.machineId });
    const [cert] = await iso.db
      .insert(certificates)
      .values({
        orgId: who.orgId,
        personId: who.personId,
        machineScope: [who.machineId],
        fingerprint: `SHA256:${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    await tick();

    expect((await reconcileActivation(iso.db, MANAGED)).kind).toBe("activated");
    expect(await readModeRow(iso.db)).toMatchObject({
      enabled: true,
      configFingerprint: MANAGED.fingerprint,
    });
    expect(await sessionCount(who.authUserId)).toBe(0);
    expect((await personRow(who.personId)).idpRolesVerifiedAt).toBeNull();
    const [certAfter] = await iso.db
      .select()
      .from(certificates)
      .where(eq(certificates.id, cert?.id ?? ""));
    expect(certAfter?.revokedReason).toBe("idp_roles_activation");
    // Machine (automation) credentials are not human credentials: untouched.
    const agent = await agentToken();
    expect(await Effect.runPromise(agent.verify(machineCred.token))).toEqual({
      orgId: who.orgId,
      machineId: who.machineId,
    });

    // A restart with the same config does nothing.
    const revokedAt = (await personRow(who.personId)).credentialsRevokedAt;
    expect((await reconcileActivation(iso.db, MANAGED)).kind).toBe("unchanged");
    expect((await personRow(who.personId)).credentialsRevokedAt?.getTime()).toBe(
      revokedAt?.getTime(),
    );

    // Through the API: the old token is refused, a fresh SSO sign-in plus a new token works.
    setMode(MANAGED);
    expect((await me(token)).status).toBe(401);
    expect((await signIn(who, "Cloudable.Admin")).refused).toBeNull();
    const fresh = issueCliToken({ personId: who.personId });
    expect((await me(fresh)).status).toBe(200);
    // ...and a restart still does not touch it.
    resetActivationForTest();
    expect((await me(fresh)).status).toBe(200);

    // Remapping is a new epoch; so is off then on.
    expect((await reconcileActivation(iso.db, REMAPPED)).kind).toBe("activated");
    expect((await reconcileActivation(iso.db, null)).kind).toBe("disabled");
    expect((await reconcileActivation(iso.db, null)).kind).toBe("unchanged");
    expect((await reconcileActivation(iso.db, MANAGED)).kind).toBe("activated");
    const activations = await auditEvents(who.orgId, "idp_roles.activation");
    expect(activations.map((e) => (e.payload as { reason: string }).reason)).toEqual([
      "enabled",
      "config_changed",
      "disabled",
      "enabled",
    ]);
  });

  test("password sign-in is forced off in managed mode, even where it would default on", async () => {
    const loaded = await loadConfig({
      IDP_METADATA_URL: "https://idp.example/metadata",
      IDP_SAML_CONFIG: SAML_CONFIG,
      IDP_ROLES_ENABLED: "true",
      IDP_ROLE_CLAIM: CLAIM,
      IDP_ROLE_MAPPING: '{"Cloudable.Admin":["admin"]}',
      PASSWORD_SIGN_IN: undefined,
    });
    expect(loaded.passwordSignInEnabled).toBe(false);
    expect(loaded.idpRoles?.enabled).toBe(true);
    await expect(
      loadConfig({
        IDP_METADATA_URL: "https://idp.example/metadata",
        IDP_SAML_CONFIG: SAML_CONFIG,
        IDP_ROLES_ENABLED: "true",
        IDP_ROLE_CLAIM: CLAIM,
        IDP_ROLE_MAPPING: '{"Cloudable.Admin":["admin"]}',
        PASSWORD_SIGN_IN: "on",
      }),
    ).rejects.toThrow(/PASSWORD_SIGN_IN/);
    // Mode off keeps today's behaviour.
    const off = await loadConfig({
      IDP_METADATA_URL: undefined,
      IDP_SAML_CONFIG: undefined,
      IDP_ROLES_ENABLED: undefined,
      PASSWORD_SIGN_IN: "on",
    });
    expect(off.passwordSignInEnabled).toBe(true);
  });

  // --- the shared acceptance suite, on the native harness above --------------------------

  test("shared contract acceptance (runAdapterAcceptance)", async () => {
    const observe = async (scenario: AcceptanceScenario): Promise<AcceptanceObservation> => {
      switch (scenario) {
        case "mode_off": {
          await forceModeRow(null);
          const admin = await seed("owner");
          const token = issueCliToken({ personId: admin.personId });
          const patched = await call(token, "PATCH", `/api/v1/people/${admin.personId}`, {
            approver: true,
          });
          return {
            nativeIntegration: true,
            allowed: (await me(token)).status === 200 && patched.status === 200,
            grants: grantsOfRow(await personRow(admin.personId)),
            localBehaviorPreserved: patched.status === 200,
          };
        }
        case "grant": {
          await forceModeRow(MANAGED);
          const who = await seed("member");
          await signIn(who, ["Cloudable.Admin", "Cloudable.Approver"]);
          return {
            nativeIntegration: true,
            allowed: (await me(issueCliToken({ personId: who.personId }))).status === 200,
            grants: grantsOfRow(await personRow(who.personId)),
          };
        }
        case "remove": {
          await forceModeRow(MANAGED);
          const who = await seed("admin", {
            approver: true,
            verifiedAt: new Date(Date.now() - 60_000),
          });
          const previousGrants = grantsOfRow(await personRow(who.personId));
          await signIn(who, "Cloudable.Member");
          return {
            nativeIntegration: true,
            allowed: (await me(issueCliToken({ personId: who.personId }))).status === 200,
            grants: grantsOfRow(await personRow(who.personId)),
            previousGrants,
          };
        }
        case "deny":
        case "invalid_claim":
        case "credentials_revoked": {
          await forceModeRow(MANAGED);
          const who = await seed("admin", {
            approver: true,
            verifiedAt: new Date(Date.now() - 60_000),
          });
          const oldToken = issueCliToken({ personId: who.personId });
          const machineCred = (await agentToken()).mint({
            orgId: who.orgId,
            machineId: who.machineId,
          });
          await tick();
          const claim =
            scenario === "deny" ? ["Some.Other.App"] : scenario === "invalid_claim" ? [42, ""] : [];
          const { refused } = await signIn(who, claim);
          const row = await personRow(who.personId);
          const agentStillValid = await Effect.runPromise(
            (await agentToken()).verify(machineCred.token).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
          );
          return {
            nativeIntegration: true,
            allowed:
              refused === null &&
              (await me(issueCliToken({ personId: who.personId }))).status === 200,
            grants: row.idpRolesVerifiedAt === null ? [] : grantsOfRow(row),
            humanSessionsRevoked: (await sessionCount(who.authUserId)) === 0,
            userCredentialsRevoked:
              (await me(oldToken)).status === 401 && (await redeemCode(who)).status === 403,
            automationCredentialsPreserved: agentStillValid,
          };
        }
        case "password_refused": {
          const loaded = await loadConfig({
            IDP_METADATA_URL: "https://idp.example/metadata",
            IDP_SAML_CONFIG: SAML_CONFIG,
            IDP_ROLES_ENABLED: "true",
            IDP_ROLE_CLAIM: CLAIM,
            IDP_ROLE_MAPPING: '{"Cloudable.Admin":["admin"]}',
            PASSWORD_SIGN_IN: undefined,
          });
          const forcedOn = await loadConfig({
            IDP_METADATA_URL: "https://idp.example/metadata",
            IDP_SAML_CONFIG: SAML_CONFIG,
            IDP_ROLES_ENABLED: "true",
            IDP_ROLE_CLAIM: CLAIM,
            IDP_ROLE_MAPPING: '{"Cloudable.Admin":["admin"]}',
            PASSWORD_SIGN_IN: "on",
          }).then(
            () => true,
            () => false,
          );
          return {
            nativeIntegration: true,
            allowed: loaded.passwordSignInEnabled || forcedOn,
            grants: [],
            requiresSso: !loaded.passwordSignInEnabled && !forcedOn,
          };
        }
        case "local_change_refused": {
          await forceModeRow(MANAGED);
          const admin = await seed("admin");
          await signIn(admin, "Cloudable.Admin");
          const res = await call(
            issueCliToken({ personId: admin.personId }),
            "PATCH",
            `/api/v1/people/${admin.personId}`,
            {
              role: "owner",
            },
          );
          return {
            nativeIntegration: true,
            allowed: res.status < 300,
            grants: grantsOfRow(await personRow(admin.personId)),
            statusCode: res.status,
            errorCode: String(res.body.code),
            message: String(res.body.message),
          };
        }
        case "freshness_deadline": {
          await forceModeRow(MANAGED, new Date(Date.now() - 7200_000));
          const stale = new Date(Date.now() - MANAGED.intervalSec * 1000);
          const who = await seed("admin", { verifiedAt: stale });
          const res = await me(issueCliToken({ personId: who.personId }));
          const row = await personRow(who.personId);
          return {
            nativeIntegration: true,
            allowed: res.status === 200,
            grants: grantsOfRow(row),
            requiresSso: res.body.reason === "idp_reauthentication_required",
            verifiedAtUnchanged: row.idpRolesVerifiedAt?.getTime() === stale.getTime(),
          };
        }
        case "activation": {
          await forceModeRow(null);
          const who = await seed("owner", { verifiedAt: new Date() });
          const oldToken = issueCliToken({ personId: who.personId });
          const machineCred = (await agentToken()).mint({
            orgId: who.orgId,
            machineId: who.machineId,
          });
          await tick();
          const first = await reconcileActivation(iso.db, MANAGED);
          const revokedAt = (await personRow(who.personId)).credentialsRevokedAt?.getTime();
          const second = await reconcileActivation(iso.db, MANAGED);
          const mode = await readModeRow(iso.db);
          setMode(MANAGED);
          const humanSessionsRevoked = (await sessionCount(who.authUserId)) === 0;
          const userCredentialsRevoked = (await me(oldToken)).status === 401;
          await signIn(who, "Cloudable.Admin");
          const newlyVerifiedSessionValid =
            (await me(issueCliToken({ personId: who.personId }))).status === 200;
          return {
            nativeIntegration: true,
            allowed: newlyVerifiedSessionValid,
            grants: grantsOfRow(await personRow(who.personId)),
            activationPersisted:
              first.kind === "activated" &&
              mode?.enabled === true &&
              mode.configFingerprint === MANAGED.fingerprint,
            activationIdempotent:
              second.kind === "unchanged" &&
              (await personRow(who.personId)).credentialsRevokedAt?.getTime() !== undefined &&
              revokedAt !== undefined,
            humanSessionsRevoked,
            userCredentialsRevoked,
            automationCredentialsPreserved: await Effect.runPromise(
              (await agentToken()).verify(machineCred.token).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              ),
            ),
            newlyVerifiedSessionValid,
          };
        }
        case "audit": {
          await forceModeRow(MANAGED);
          const who = await seed("member");
          await signIn(who, "Cloudable.Admin");
          const [row] = await auditEvents(who.orgId, "idp_roles.granted");
          const p = row?.payload as Record<string, unknown>;
          return {
            nativeIntegration: true,
            allowed: true,
            grants: grantsOfRow(await personRow(who.personId)),
            // Rebuilt from the stored row in the contract's field order (jsonb does not keep it).
            audit: {
              event: row?.type as "idp_roles.granted",
              service: p.service as string,
              actor: p.actor as string,
              subject: p.subject as string,
              source: p.source as "saml",
              previousGrants: p.previousGrants as string[],
              newGrants: p.newGrants as string[],
              reason: p.reason as string,
            },
          };
        }
      }
    };
    const result = await runAdapterAcceptance({ run: observe });
    expect(result.passed).toBe(11);
  });
});

// --- helpers outside the suite -------------------------------------------------------------

const SAML_CONFIG = JSON.stringify({
  entityId: "https://sts.windows.net/tenant/",
  ssoUrl: "https://login.microsoftonline.com/tenant/saml2",
  sloUrl: "https://login.microsoftonline.com/tenant/saml2",
  emailDomains: "example.com",
  certs: ["MIIC-fake-cert"],
});

type ConfigModule = typeof import("../config");

/** `config.ts` reads `process.env` once at module load: re-import it under a given env. */
const loadConfig = async (env: Record<string, string | undefined>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const module = (await import(`../config?idp-roles=${crypto.randomUUID()}`)) as ConfigModule;
    return module.config;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** The tunnel relay with its real dependencies, on whatever database `config.databaseUrl` names. */
const relayLayer = () =>
  TunnelRelay.Default.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        TunnelServer.Default.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              EventBus.Default.pipe(Layer.provide(DbLive)),
              LocalSignerLive,
              DbLive,
              TunnelSignal.Default,
            ),
          ),
        ),
        TunnelRegistry.Default,
      ),
    ),
  );
