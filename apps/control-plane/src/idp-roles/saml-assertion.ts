import { AsyncLocalStorage } from "node:async_hooks";
import { DOMParser } from "@xmldom/xmldom";

const PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";

/** How old a signed assertion may be when it arrives: the AuthnRequest lifetime (`auth.ts`). */
export const MAX_ASSERTION_AGE_MS = 5 * 60 * 1000;
/** How far in the future an assertion's IssueInstant may be (clock skew), at most. */
export const MAX_ASSERTION_FUTURE_MS = 60 * 1000;

/**
 * What one posted SAML response says, read from its XML before `@better-auth/sso` processes it.
 * Facts about the Assertion are only trusted once the plugin has verified that this same sole
 * Assertion carries the IdP's signature (`wantAssertionsSigned`, `auth.ts`); the hook that reads
 * them runs only after that.
 */
export interface AssertionFacts {
  /** `InResponseTo` on the outer Response: what the plugin checks against its stored requests.
   * Not signed in general (Entra signs only the assertion by default). */
  readonly responseInResponseTo: string | null;
  /** Number of Assertion elements anywhere in the document. Must be exactly 1. */
  readonly assertionCount: number;
  /** Number of EncryptedAssertion elements. Not supported in this mode. */
  readonly encryptedCount: number;
  /** The sole Assertion's IssueInstant (ms), inside the signed element. */
  readonly issueInstant: number | null;
  /** InResponseTo on every bearer SubjectConfirmationData of the sole Assertion, inside the
   * signed element. */
  readonly signedInResponseTo: readonly (string | null)[];
}

export const readAssertionFacts = (samlResponseBase64: string): AssertionFacts | null => {
  let xml: string;
  try {
    xml = Buffer.from(samlResponseBase64.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root || root.localName !== "Response" || root.namespaceURI !== PROTOCOL_NS) return null;
  const assertions = doc.getElementsByTagNameNS(ASSERTION_NS, "Assertion");
  const encrypted = doc.getElementsByTagNameNS(ASSERTION_NS, "EncryptedAssertion");
  const assertion = assertions.length === 1 ? assertions.item(0) : null;
  let issueInstant: number | null = null;
  const signedInResponseTo: (string | null)[] = [];
  if (assertion) {
    const raw = assertion.getAttribute("IssueInstant");
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    issueInstant = Number.isFinite(parsed) ? parsed : null;
    const confirmations = assertion.getElementsByTagNameNS(ASSERTION_NS, "SubjectConfirmation");
    for (let i = 0; i < confirmations.length; i++) {
      const confirmation = confirmations.item(i);
      if (!confirmation || confirmation.getAttribute("Method") !== BEARER) continue;
      const data = confirmation.getElementsByTagNameNS(ASSERTION_NS, "SubjectConfirmationData");
      if (data.length === 0) signedInResponseTo.push(null);
      for (let j = 0; j < data.length; j++) {
        signedInResponseTo.push(data.item(j)?.getAttribute("InResponseTo") || null);
      }
    }
  }
  return {
    responseInResponseTo: root.getAttribute("InResponseTo") || null,
    assertionCount: assertions.length,
    encryptedCount: encrypted.length,
    issueInstant,
    signedInResponseTo,
  };
};

export type FreshAssertion =
  | { readonly ok: true; readonly issuedAt: Date }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether the verified assertion is fresh, bound to the request this deployment issued, by its
 * own signed fields, not the unsigned envelope:
 *
 * - exactly one plaintext Assertion (no encrypted ones);
 * - every bearer SubjectConfirmationData carries `InResponseTo`, and it equals the Response's
 *   `InResponseTo`, which the plugin has already matched to an AuthnRequest it issued and
 *   consumed (single use, stored in the database, at most 5 minutes old). So the signed assertion
 *   itself answers that request: an older signed assertion cannot be re-wrapped in a new
 *   envelope;
 * - its signed IssueInstant is at most `MAX_ASSERTION_AGE_MS` old and not in the future beyond
 *   `MAX_ASSERTION_FUTURE_MS`.
 *
 * The IssueInstant is what Cloudable records as the time of the role evidence.
 */
export const checkFreshAssertion = (
  facts: AssertionFacts | undefined,
  nowMs: number,
): FreshAssertion => {
  if (!facts) return { ok: false, reason: "saml_assertion_unreadable" };
  if (facts.encryptedCount > 0) return { ok: false, reason: "saml_assertion_encrypted" };
  if (facts.assertionCount !== 1) return { ok: false, reason: "saml_assertion_count" };
  if (!facts.responseInResponseTo) return { ok: false, reason: "saml_unsolicited" };
  if (
    facts.signedInResponseTo.length === 0 ||
    facts.signedInResponseTo.some((value) => value !== facts.responseInResponseTo)
  ) {
    return { ok: false, reason: "saml_assertion_not_bound_to_request" };
  }
  if (facts.issueInstant === null) return { ok: false, reason: "saml_assertion_no_issue_instant" };
  if (facts.issueInstant > nowMs + MAX_ASSERTION_FUTURE_MS) {
    return { ok: false, reason: "saml_assertion_from_future" };
  }
  if (nowMs - facts.issueInstant > MAX_ASSERTION_AGE_MS) {
    return { ok: false, reason: "saml_assertion_stale" };
  }
  return { ok: true, issuedAt: new Date(Math.min(facts.issueInstant, nowMs)) };
};

/** The facts of the SAML response the current request posted, if any. */
const current = new AsyncLocalStorage<AssertionFacts | undefined>();

export const currentAssertionFacts = (): AssertionFacts | undefined => current.getStore();

/** Runs `fn` as if handling a posted SAML response with these facts. For tests of the hook. */
export const runWithAssertionFacts = <A>(facts: AssertionFacts | undefined, fn: () => Promise<A>) =>
  current.run(facts, fn);

const ACS_PATH = /\/sso\/saml2\/sp\/acs\/[^/]+\/?$/;

/**
 * Runs a BetterAuth request, and for a SAML assertion-consumer POST, makes the posted response's
 * facts available to the sign-in hook (`currentAssertionFacts`) for the whole handling of it.
 * The body is read once and handed on unchanged.
 */
export const withAssertionFacts = async (
  request: Request,
  handle: (request: Request) => Promise<Response>,
): Promise<Response> => {
  if (request.method !== "POST" || !ACS_PATH.test(new URL(request.url).pathname)) {
    return handle(request);
  }
  const body = await request.text();
  let facts: AssertionFacts | undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const samlResponse = new URLSearchParams(body).get("SAMLResponse");
    facts = samlResponse ? (readAssertionFacts(samlResponse) ?? undefined) : undefined;
  } else if (contentType.includes("application/json")) {
    try {
      const samlResponse = (JSON.parse(body) as { SAMLResponse?: unknown }).SAMLResponse;
      facts =
        typeof samlResponse === "string"
          ? (readAssertionFacts(samlResponse) ?? undefined)
          : undefined;
    } catch {
      facts = undefined;
    }
  }
  const forwarded = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
  return current.run(facts, () => handle(forwarded));
};
