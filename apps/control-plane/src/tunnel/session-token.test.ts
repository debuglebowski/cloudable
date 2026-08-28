import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SignerTag } from "../services/Signer";
import { LocalSignerLive } from "../services/Signer.local";
import {
  SESSION_TOKEN_KEY_ID,
  type SessionClaims,
  mintSessionToken,
  verifySessionToken,
} from "./session-token";

const baseInput = {
  idpIdentity: "kalle@normain.com",
  targetMachineId: "machine-1",
  targetOsUser: "ubuntu",
  method: "terminal" as const,
};

describe("session-token", () => {
  test("a freshly minted token verifies and round-trips the claims", async () => {
    const program = Effect.gen(function* () {
      const minted = yield* mintSessionToken(baseInput);
      const claims = yield* verifySessionToken(minted.token);
      return { minted, claims };
    });

    const { minted, claims } = await Effect.runPromise(Effect.provide(program, LocalSignerLive));
    expect(claims.idpIdentity).toBe(baseInput.idpIdentity);
    expect(claims.targetMachineId).toBe(baseInput.targetMachineId);
    expect(claims.targetOsUser).toBe(baseInput.targetOsUser);
    expect(claims.method).toBe(baseInput.method);
    expect(claims.expiresAt.getTime()).toBe(minted.expiresAt.getTime());
    expect(claims.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  // Explicit failure-path test required by CLAUDE.md / docs/spec.md §25: "a session token
  // with a broken signature must be refused." Valid claims, valid expiry, wrong signature.
  test("REQUIRED FAILURE PATH: a token with a tampered signature is refused", async () => {
    const program = Effect.gen(function* () {
      const minted = yield* mintSessionToken(baseInput);
      const [claimsSegment, signatureSegment] = minted.token.split(".") as [string, string];

      // Flip one bit in the signature segment's decoded bytes, re-encode.
      const sigBytes = Buffer.from(signatureSegment, "base64url");
      sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff;
      const tamperedToken = `${claimsSegment}.${sigBytes.toString("base64url")}`;

      return yield* Effect.flip(verifySessionToken(tamperedToken));
    });

    const error = await Effect.runPromise(Effect.provide(program, LocalSignerLive));
    expect(error.reason).toBe("invalid_signature");
  });

  test("REQUIRED FAILURE PATH: tampering with the claims (leaving the old signature) is refused", async () => {
    const program = Effect.gen(function* () {
      const minted = yield* mintSessionToken(baseInput);
      const [claimsSegment, signatureSegment] = minted.token.split(".") as [string, string];

      const claims = JSON.parse(Buffer.from(claimsSegment, "base64url").toString("utf8"));
      claims.targetOsUser = "root"; // privilege-escalation attempt via claim tampering
      const forgedClaimsSegment = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const forgedToken = `${forgedClaimsSegment}.${signatureSegment}`;

      return yield* Effect.flip(verifySessionToken(forgedToken));
    });

    const error = await Effect.runPromise(Effect.provide(program, LocalSignerLive));
    expect(error.reason).toBe("invalid_signature");
  });

  test("a well-signed but expired token is refused only after the signature checks out", async () => {
    const program = Effect.gen(function* () {
      const signer = yield* SignerTag;
      const claims = {
        idpIdentity: baseInput.idpIdentity,
        targetMachineId: baseInput.targetMachineId,
        targetOsUser: baseInput.targetOsUser,
        method: baseInput.method,
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString(), // already expired
      };
      const claimsSegment = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
      const signature = yield* signer.sign({
        keyId: SESSION_TOKEN_KEY_ID,
        algorithm: "ed25519",
        data: new TextEncoder().encode(claimsSegment),
      });
      const token = `${claimsSegment}.${Buffer.from(signature).toString("base64url")}`;
      return yield* Effect.flip(verifySessionToken(token));
    });

    const error = await Effect.runPromise(Effect.provide(program, LocalSignerLive));
    expect(error.reason).toBe("expired");
  });

  test("a malformed token (no separator) is refused", async () => {
    const error = await Effect.runPromise(
      Effect.provide(Effect.flip(verifySessionToken("not-a-token")), LocalSignerLive),
    );
    expect(error.reason).toBe("malformed");
  });

  test("claims signed for one CA key do not verify against a different signer instance", async () => {
    const minted = await Effect.runPromise(
      Effect.provide(mintSessionToken(baseInput), LocalSignerLive),
    );

    // A second, independent LocalSignerLive layer generates a *different* in-memory keypair
    // for the same keyId — simulating a token forged against/for the wrong CA key material.
    const error = await Effect.runPromise(
      Effect.provide(Effect.flip(verifySessionToken(minted.token)), LocalSignerLive),
    );
    expect(error.reason).toBe("invalid_signature");
  });

  test("verified claims type-check as SessionClaims", async () => {
    const program = Effect.gen(function* () {
      const minted = yield* mintSessionToken(baseInput);
      const claims: SessionClaims = yield* verifySessionToken(minted.token);
      return claims;
    });
    const claims = await Effect.runPromise(Effect.provide(program, LocalSignerLive));
    expect(claims.issuedAt).toBeInstanceOf(Date);
  });
});
