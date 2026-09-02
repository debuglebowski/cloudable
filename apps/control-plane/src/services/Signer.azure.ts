// ---------------------------------------------------------------------------
// SECURITY: this file and `Signer.local.ts` are the ONLY two files anywhere
// in this codebase allowed to touch raw key material — the CA private key
// never enters the control plane, sign operations only. This particular
// file touches none yet — it is a stub.
// ---------------------------------------------------------------------------
//
// STUB: no Azure Key Vault account exists in this build. Every method fails
// with `not_implemented`. A future unit swaps this in behind the same
// `Signer` port once a real Azure account is available, calling into Key
// Vault's sign/getKey APIs — the private key itself must never leave Key
// Vault, so this adapter should only ever call sign/verify
// operations, never export or import key material.
import { Effect, Layer } from "effect";
import { type Signer, SignerError, SignerTag } from "./Signer";

const notImplemented = Effect.fail(
  new SignerError({
    reason: "not_implemented",
    cause: "no Azure Key Vault account configured in this build",
  }),
);

const signer: Signer = {
  sign: () => notImplemented,
  publicKey: () => notImplemented,
};

export const AzureSignerLive = Layer.succeed(SignerTag, signer);
