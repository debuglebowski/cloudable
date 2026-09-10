import { Context, Data, type Effect } from "effect";

export class SignerError extends Data.TaggedError("SignerError")<{
  reason: string;
  cause?: unknown;
}> {}

export interface SignRequest {
  keyId: string;
  /**
   * `ecdsa-sha2-nistp256` is what the SSH CA uses — Key Vault has no Ed25519
   * (RSA, EC P-256/256K/384/521, oct only), and invariant #9 requires the key
   * to live somewhere that signs without exporting.
   */
  algorithm: "ecdsa-sha2-nistp256" | "rsa-sha256";
  data: Uint8Array;
}

/**
 * Port for signing operations. The CA private key
 * never enters the control plane — sign operations only. Implementations
 * hold key material themselves and expose only sign/publicKey — never a
 * raw key export.
 */
export interface Signer {
  sign(req: SignRequest): Effect.Effect<Uint8Array, SignerError>;
  publicKey(keyId: string): Effect.Effect<Uint8Array, SignerError>;
}

export class SignerTag extends Context.Tag("Signer")<SignerTag, Signer>() {}
