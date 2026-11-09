/**
 * Child process for `saml-acs.integration.test.ts`: a control plane configured with a test SAML
 * identity provider, driven through BetterAuth's real `/sso/saml2/sp/acs/:providerId` endpoint
 * with real signed XML. Run as its own process because `auth.ts` builds BetterAuth from config at
 * module load, and so that a second run is a real restart (nothing in memory survives).
 *
 * Input: env (the IdP config, the isolated DATABASE_URL, HARNESS_KEY_PEM, HARNESS_CERT_PEM,
 * HARNESS_STEPS as JSON). Output: one JSON line with every step's result.
 */
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

type Step =
  | { kind: "post"; name: string; email: string; roles: string[]; variant: Variant }
  | { kind: "replay"; name: string; body: string }
  | {
      kind: "across_epoch";
      name: string;
      email: string;
      roles: string[];
      /** Put the pre-epoch AuthnRequest back after activation dropped it, so only Cloudable's
       * own epoch check stands between the old assertion and a session. */
      restoreRequest: boolean;
    };
type Variant =
  | "valid"
  | "rewrapped_old_assertion"
  | "stale_issue_instant"
  | "unsigned_assertion"
  | "tampered_after_signing"
  | "no_scd_in_response_to";

const steps = JSON.parse(process.env.HARNESS_STEPS ?? "[]") as Step[];
const keyPem = process.env.HARNESS_KEY_PEM ?? "";
const certPem = process.env.HARNESS_CERT_PEM ?? "";
const base = process.env.BETTER_AUTH_URL ?? "";
const entityId = JSON.parse(process.env.IDP_SAML_CONFIG ?? "{}").entityId as string;
const claim = process.env.IDP_ROLE_CLAIM ?? "";

const { auth } = await import("../auth");
const { config } = await import("../config");
const { authDb } = await import("../auth");
const { ensureActivation, reconcileActivation } = await import("./activation");
const { authVerification } = await import("@cloudable/schema");
const { eq } = await import("drizzle-orm");
await ensureActivation(authDb, config.idpRoles);

const acs = `${base}/api/auth/sso/saml2/sp/acs/configured`;
const audience = `${base}/api/auth/sso/saml2/sp/metadata`;

/** Starts an SP-initiated sign-in the way the console does; returns the request id and RelayState. */
const startSignIn = async () => {
  const response = await auth.handler(
    new Request(`${base}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ providerId: "configured", callbackURL: `${base}/` }),
    }),
  );
  const { url } = (await response.json()) as { url: string };
  const params = new URL(url).searchParams;
  const xml = inflateRawSync(Buffer.from(params.get("SAMLRequest") ?? "", "base64")).toString();
  const id = /\sID="([^"]+)"/.exec(xml)?.[1] ?? "";
  return { id, relayState: params.get("RelayState") ?? "" };
};

const iso = (ms: number) => new Date(ms).toISOString();

const assertionXml = (o: {
  id: string;
  issueInstant: number;
  scdInResponseTo: string | null;
  email: string;
  roles: string[];
}) => {
  const now = Date.now();
  const scd = `<saml:SubjectConfirmationData${o.scdInResponseTo ? ` InResponseTo="${o.scdInResponseTo}"` : ""} NotOnOrAfter="${iso(now + 3600_000)}" Recipient="${acs}"/>`;
  const roleValues = o.roles.map((r) => `<saml:AttributeValue>${r}</saml:AttributeValue>`).join("");
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${o.id}" Version="2.0" IssueInstant="${iso(o.issueInstant)}"><saml:Issuer>${entityId}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">${scd}</saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${iso(now + 3600_000)}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(o.issueInstant)}" SessionIndex="_s${o.id}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${o.email}</saml:AttributeValue></saml:Attribute>${o.roles.length ? `<saml:Attribute Name="${claim}">${roleValues}</saml:Attribute>` : ""}</saml:AttributeStatement></saml:Assertion>`;
};

const sign = (xml: string) => {
  const sig = new SignedXml({
    privateKey: keyPem,
    publicCert: certPem,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(xml, {
    location: {
      reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
      action: "after",
    },
  });
  return sig.getSignedXml();
};

const responseXml = (inResponseTo: string, assertion: string) =>
  `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomUUID()}" Version="2.0" IssueInstant="${iso(Date.now())}" Destination="${acs}" InResponseTo="${inResponseTo}"><saml:Issuer>${entityId}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;

const post = async (body: string) => {
  const response = await auth.handler(
    new Request(acs, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
  const location = response.headers.get("location") ?? "";
  let error: string | null = null;
  try {
    error = new URL(location, base).searchParams.get("error");
  } catch {}
  return {
    status: response.status,
    error,
    sessionCookie: (response.headers.get("set-cookie") ?? "").includes("session_token"),
  };
};

const results: Record<string, unknown> = {};
for (const step of steps) {
  if (step.kind === "replay") {
    results[step.name] = await post(step.body);
    continue;
  }
  if (step.kind === "across_epoch") {
    // Request and signed assertion before the switch; the switch (off, then on again: a new
    // activation epoch); the post after it, well inside the assertion's 5 minutes.
    const request = await startSignIn();
    const issueInstant = Date.now();
    const assertion = sign(
      assertionXml({
        id: `_a${crypto.randomUUID()}`,
        issueInstant,
        scdInResponseTo: request.id,
        email: step.email,
        roles: step.roles,
      }),
    );
    const key = `saml-authn-request:${request.id}`;
    const [pending] = await authDb
      .select()
      .from(authVerification)
      .where(eq(authVerification.identifier, key));
    await new Promise((r) => setTimeout(r, 10));
    await reconcileActivation(authDb, null);
    await reconcileActivation(authDb, config.idpRoles);
    const dropped =
      (await authDb.select().from(authVerification).where(eq(authVerification.identifier, key)))
        .length === 0;
    if (step.restoreRequest && pending) await authDb.insert(authVerification).values(pending);
    const body = new URLSearchParams({
      SAMLResponse: Buffer.from(responseXml(request.id, assertion)).toString("base64"),
      RelayState: request.relayState,
    }).toString();
    results[step.name] = {
      ...(await post(body)),
      issueInstant,
      requestDroppedByActivation: dropped,
    };
    continue;
  }
  const request = await startSignIn();
  const assertionId = `_a${crypto.randomUUID()}`;
  let issueInstant = Date.now();
  let scd: string | null = request.id;
  if (step.variant === "rewrapped_old_assertion") {
    // A signed assertion issued for an earlier request, never used, still inside NotOnOrAfter,
    // wrapped in a fresh unsigned envelope that names the current request.
    scd = (await startSignIn()).id;
    issueInstant = Date.now() - 120_000;
  }
  if (step.variant === "stale_issue_instant") issueInstant = Date.now() - 10 * 60_000;
  if (step.variant === "no_scd_in_response_to") scd = null;
  const unsigned = assertionXml({
    id: assertionId,
    issueInstant,
    scdInResponseTo: scd,
    email: step.email,
    roles: step.roles,
  });
  let assertion = step.variant === "unsigned_assertion" ? unsigned : sign(unsigned);
  if (step.variant === "tampered_after_signing") {
    assertion = assertion.replace(
      "<saml:AttributeValue>Cloudable.Member</saml:AttributeValue>",
      "<saml:AttributeValue>Cloudable.Admin</saml:AttributeValue>",
    );
  }
  const xml = responseXml(request.id, assertion);
  const body = new URLSearchParams({
    SAMLResponse: Buffer.from(xml).toString("base64"),
    RelayState: request.relayState,
  }).toString();
  results[step.name] = { ...(await post(body)), body, issueInstant };
}
console.log(`HARNESS_RESULT ${JSON.stringify(results)}`);
process.exit(0);
