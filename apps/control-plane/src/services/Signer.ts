import { Context, Data, type Effect } from "effect";

export class SignerError extends Data.TaggedError("SignerError")<{
  reason: string;
  cause?: unknown;
}> {}

export interface SignRequest {
  keyId: string;
  algorithm: "ed25519" | "rsa-sha256";
  data: Uint8Array;
}

/**
 * Port for signing operations (CLAUDE.md invariant #9: "The CA private key
 * never enters the control plane. Sign operations only."). Implementations
 * hold key material themselves and expose only sign/publicKey — never a
 * raw key export.
 */
export interface Signer {
  sign(req: SignRequest): Effect.Effect<Uint8Array, SignerError>;
  publicKey(keyId: string): Effect.Effect<Uint8Array, SignerError>;
}

export class SignerTag extends Context.Tag("Signer")<SignerTag, Signer>() {}
