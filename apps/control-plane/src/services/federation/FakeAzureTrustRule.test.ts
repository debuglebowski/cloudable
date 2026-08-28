import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { type FakeAzureTrustRule, validateAgainstTrustRule } from "./FakeAzureTrustRule";
import { type FederationClaims, assembleJws, encodeSigningInput } from "./jwt";

const ISSUER = "https://auth.cloudable.example";

/** A syntactically-valid JWT with an arbitrary (unsigned) signature segment — `validateAgainstTrustRule` never checks the signature, only claims. */
const fakeToken = (claims: FederationClaims): string => {
  const signingInput = encodeSigningInput({ alg: "EdDSA", typ: "JWT", kid: "test-key" }, claims);
  return assembleJws(signingInput, new Uint8Array([1, 2, 3]));
};

const claimsFor = (sub: string, overrides: Partial<FederationClaims> = {}): FederationClaims => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub,
    aud: "api://AzureADTokenExchange",
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
};

describe("validateAgainstTrustRule", () => {
  test("accepts a token whose issuer and subject match the rule", async () => {
    const token = fakeToken(claimsFor("cloudable:tenant:tenant-a"));
    const rule: FakeAzureTrustRule = { issuer: ISSUER, boundSubject: "cloudable:tenant:tenant-a" };

    const result = await Effect.runPromise(validateAgainstTrustRule(token, rule));
    expect(result).toEqual({ issuer: ISSUER, subject: "cloudable:tenant:tenant-a" });
  });

  test("rejects with subject_mismatch when the subject doesn't match, even with the same issuer", async () => {
    const token = fakeToken(claimsFor("cloudable:tenant:tenant-a"));
    const rule: FakeAzureTrustRule = { issuer: ISSUER, boundSubject: "cloudable:tenant:tenant-b" };

    const error = await Effect.runPromise(Effect.flip(validateAgainstTrustRule(token, rule)));
    expect(error.reason).toBe("subject_mismatch");
  });

  test("rejects with issuer_mismatch when the issuer doesn't match", async () => {
    const token = fakeToken(claimsFor("cloudable:tenant:tenant-a"));
    const rule: FakeAzureTrustRule = {
      issuer: "https://not-cloudable.example",
      boundSubject: "cloudable:tenant:tenant-a",
    };

    const error = await Effect.runPromise(Effect.flip(validateAgainstTrustRule(token, rule)));
    expect(error.reason).toBe("issuer_mismatch");
  });

  test("rejects with expired when exp is in the past", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = fakeToken(claimsFor("cloudable:tenant:tenant-a", { exp: now - 60 }));
    const rule: FakeAzureTrustRule = { issuer: ISSUER, boundSubject: "cloudable:tenant:tenant-a" };

    const error = await Effect.runPromise(Effect.flip(validateAgainstTrustRule(token, rule)));
    expect(error.reason).toBe("expired");
  });

  test("rejects with malformed_token for garbage input", async () => {
    const rule: FakeAzureTrustRule = { issuer: ISSUER, boundSubject: "cloudable:tenant:tenant-a" };
    const error = await Effect.runPromise(Effect.flip(validateAgainstTrustRule("not-a-jwt", rule)));
    expect(error.reason).toBe("malformed_token");
  });
});
