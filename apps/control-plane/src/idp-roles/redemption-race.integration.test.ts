import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { authUser, certificates, idpRoleMode, orgs, people } from "@cloudable/schema";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { CONFIGURED_IDP_PROVIDER_ID, config } from "../config";
import { ApiLive } from "../http/api-live";
import { buildAppLive } from "../layers";
import { issueCliAuthCode } from "../services/CliAuthCode";
import { issueCliToken } from "../services/CliToken";
import { FakeProvisioningServiceLive } from "../services/ProvisioningService.fake";
import { FakeSecretsProviderLive } from "../services/SecretsProvider.fake";
import { SignerTag } from "../services/Signer";
import { LocalSignerLive } from "../services/Signer.local";
import { type IsolatedDb, createIsolatedDb } from "../test-support/isolated-db";
import { isDbReachable } from "../testing/db-reachable";
import { MODE_ROW_ID, reconcileActivation, resetActivationForTest } from "./activation";
import { type IdpRolesConfig, readIdpRolesConfig } from "./config";
import { runWithAssertionFacts } from "./saml-assertion";
import { IDP_ROLE_CLAIM_FIELD, idpRoleProvisioning } from "./sign-in";

/**
 * `cloudable login` redeeming a CLI sign-in code while the person's access is revoked mid-way.
 * The signer is paused inside redemption (after the first standing check, before credentials are
 * returned), the revocation commits, then the signer resumes. No credential issued in that
 * window may be usable, then or after a later fresh SSO sign-in.
 */
const BASE_URL =
  process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable";
const reachable = await isDbReachable(BASE_URL);

const idpRolesFor = (entityId: string) =>
  readIdpRolesConfig(
    {
      IDP_ROLES_ENABLED: "true",
      IDP_ROLE_CLAIM: "roles",
      IDP_ROLE_MAPPING: '{"Cloudable.Admin":["admin"]}',
    },
    {
      providerId: CONFIGURED_IDP_PROVIDER_ID,
      entityId,
      ssoUrl: "https://idp.example/sso",
      emailDomains: "example.com",
      certs: ["cert"],
    },
  ) as IdpRolesConfig;
const MANAGED = idpRolesFor("https://idp.example/");
const REMAPPED = idpRolesFor("https://new-idp.example/");

/** A signer that, once armed, stops inside `sign` until released. */
const gate = (() => {
  let armed = false;
  let entered: () => void = () => {};
  let release: () => void = () => {};
  let enteredP = Promise.resolve();
  let releaseP = Promise.resolve();
  return {
    arm() {
      armed = true;
      enteredP = new Promise<void>((r) => {
        entered = r;
      });
      releaseP = new Promise<void>((r) => {
        release = r;
      });
    },
    entered: () => enteredP,
    release: () => {
      armed = false;
      release();
    },
    layer: Layer.effect(
      SignerTag,
      Effect.map(SignerTag, (local) => ({
        publicKey: local.publicKey,
        sign: (request: Parameters<typeof local.sign>[0]) =>
          Effect.promise(async () => {
            if (!armed) return;
            entered();
            await releaseP;
          }).pipe(Effect.zipRight(local.sign(request))),
      })),
    ).pipe(Layer.provide(LocalSignerLive)),
  };
})();

describe.skipIf(!reachable)("CLI sign-in code redemption racing a revocation", () => {
  let iso: IsolatedDb;
  let handler: (request: Request) => Promise<Response>;
  let dispose: () => Promise<void>;
  const originalUrl = config.databaseUrl;
  const originalMode = config.idpRoles;

  beforeAll(async () => {
    iso = await createIsolatedDb(BASE_URL);
    (config as { databaseUrl: string }).databaseUrl = iso.url;
    const web = HttpApiBuilder.toWebHandler(
      Layer.mergeAll(ApiLive, HttpServer.layerContext).pipe(
        Layer.provide(
          buildAppLive({
            provisioning: FakeProvisioningServiceLive,
            signer: gate.layer,
            secrets: FakeSecretsProviderLive,
          }),
        ),
      ),
    );
    handler = web.handler;
    dispose = web.dispose;
  });

  afterAll(async () => {
    await dispose?.();
    (config as { databaseUrl: string }).databaseUrl = originalUrl;
    (config as { idpRoles: IdpRolesConfig | null }).idpRoles = originalMode;
    resetActivationForTest();
    await iso?.drop();
  });

  const setup = async () => {
    await iso.db.delete(idpRoleMode);
    await iso.db.insert(idpRoleMode).values({
      id: MODE_ROW_ID,
      enabled: true,
      configFingerprint: MANAGED.fingerprint,
      activatedAt: new Date(Date.now() - 3600_000),
    });
    (config as { idpRoles: IdpRolesConfig | null }).idpRoles = MANAGED;
    resetActivationForTest();
    const [org] = await iso.db.insert(orgs).values({ name: "race" }).returning();
    if (!org) throw new Error("org");
    const email = `${crypto.randomUUID()}@example.com`;
    const [person] = await iso.db
      .insert(people)
      .values({
        orgId: org.id,
        email,
        role: "admin",
        idpRolesVerifiedAt: new Date(Date.now() - 60_000),
      })
      .returning();
    if (!person) throw new Error("person");
    const authUserId = crypto.randomUUID();
    await iso.db.insert(authUser).values({
      id: authUserId,
      name: email,
      email,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { orgId: org.id, personId: person.id, email, authUserId };
  };

  const call = async (method: string, path: string, body?: unknown, token = "none") => {
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
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {}
    return { status: response.status, body: parsed };
  };

  const redeem = (code: string) =>
    call("POST", "/api/v1/access/certificates", {
      code,
      osUser: "cloudable",
      machineScope: "all",
      publicKeyBase64: crypto
        .generateKeyPairSync("ed25519")
        .publicKey.export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64"),
    });

  const signIn = (who: { email: string; authUserId: string }, claim: unknown, mode = MANAGED) =>
    runWithAssertionFacts(
      {
        responseInResponseTo: "_r",
        assertionCount: 1,
        encryptedCount: 0,
        issueInstant: Date.now(),
        signedInResponseTo: ["_r"],
      },
      () =>
        idpRoleProvisioning(iso.db, mode, "https://cloudable.example.com/login").provisionUser({
          user: { id: who.authUserId, email: who.email },
          userInfo: { [IDP_ROLE_CLAIM_FIELD]: claim },
          provider: { providerId: CONFIGURED_IDP_PROVIDER_ID },
        }),
    ).then(
      () => "ok",
      () => "refused",
    );

  test("a refused sign-in while the signer is paused: nothing is handed out, nothing usable later", async () => {
    const who = await setup();
    const code = issueCliAuthCode({ personId: who.personId, orgId: who.orgId });
    await new Promise((r) => setTimeout(r, 5));
    gate.arm();
    const pending = redeem(code);
    await gate.entered();
    expect(await signIn(who, [])).toBe("refused");
    gate.release();
    const result = await pending;
    expect(result.status).toBe(403);
    expect(result.body.token).toBeUndefined();
    // The certificate it had already stored is revoked, not left live.
    const certs = await iso.db
      .select()
      .from(certificates)
      .where(eq(certificates.personId, who.personId));
    expect(certs.every((c) => c.revokedAt !== null)).toBe(true);
  });

  test("an activation while the signer is paused: refused, and the code is dead under the new epoch", async () => {
    const who = await setup();
    const code = issueCliAuthCode({ personId: who.personId, orgId: who.orgId });
    await new Promise((r) => setTimeout(r, 5));
    gate.arm();
    const pending = redeem(code);
    await gate.entered();
    expect((await reconcileActivation(iso.db, REMAPPED)).kind).toBe("activated");
    gate.release();
    const result = await pending;
    expect(result.status).toBe(403);
    expect(result.body.token).toBeUndefined();
    // Under the new config, after a fresh SSO sign-in, the old code still mints nothing.
    (config as { idpRoles: IdpRolesConfig | null }).idpRoles = REMAPPED;
    resetActivationForTest();
    expect(await signIn(who, "Cloudable.Admin", REMAPPED)).toBe("ok");
    expect((await redeem(code)).status).toBe(403);
  });

  test("a token handed out before a revocation is dated by its code, so the revocation kills it, even after a later SSO", async () => {
    const who = await setup();
    const code = issueCliAuthCode({ personId: who.personId, orgId: who.orgId });
    await new Promise((r) => setTimeout(r, 5));
    const issued = await redeem(code);
    expect(issued.status).toBe(200);
    const token = String(issued.body.token);
    expect((await call("GET", "/api/v1/me", undefined, token)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect(await signIn(who, [])).toBe("refused");
    expect(await signIn(who, "Cloudable.Admin")).toBe("ok");
    // The person is back in, with fresh evidence; the token from before the refusal is not.
    expect(
      (await call("GET", "/api/v1/me", undefined, issueCliToken({ personId: who.personId })))
        .status,
    ).toBe(200);
    const old = await call("GET", "/api/v1/me", undefined, token);
    expect(old.status).toBe(401);
    expect(old.body.reason).toBe("credentials_revoked");
  });
});
