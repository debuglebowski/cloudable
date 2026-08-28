// ---------------------------------------------------------------------------
// SECURITY: this file and `Signer.azure.ts` are the ONLY two files anywhere
// in this codebase allowed to touch raw key material (CLAUDE.md invariant
// #9: "The CA private key never enters the control plane. Sign operations
// only."). Do not import `node:crypto` key APIs, or read/write key files,
// from anywhere else — go through the `Signer` port instead.
// ---------------------------------------------------------------------------
import * as crypto from "node:crypto";
import { Effect, Layer, Ref } from "effect";
import { type SignRequest, type Signer, SignerError, SignerTag } from "./Signer";

interface KeyPair {
  readonly publicKey: crypto.KeyObject;
  readonly privateKey: crypto.KeyObject;
}

const generateKeyPair = (): KeyPair => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
};

/**
 * Dev/test `Signer` implementation. Keys are ed25519, generated on first use
 * and held in memory for the lifetime of the process — deliberately simple
 * for a skeleton build (no Azure Key Vault account exists yet; see
 * `Signer.azure.ts`). Not durable across restarts, and not for production.
 */
export const LocalSignerLive = Layer.effect(
  SignerTag,
  Effect.gen(function* () {
    const keys = yield* Ref.make(new Map<string, KeyPair>());

    const getOrCreate = (keyId: string): Effect.Effect<KeyPair> =>
      Ref.modify(keys, (map) => {
        const existing = map.get(keyId);
        if (existing) return [existing, map];
        const created = generateKeyPair();
        const next = new Map(map);
        next.set(keyId, created);
        return [created, next];
      });

    const sign: Signer["sign"] = (req: SignRequest) =>
      Effect.gen(function* () {
        if (req.algorithm !== "ed25519") {
          return yield* Effect.fail(
            new SignerError({
              reason: "unsupported_algorithm",
              cause: `local signer only supports ed25519, got: ${req.algorithm}`,
            }),
          );
        }
        const { privateKey } = yield* getOrCreate(req.keyId);
        return yield* Effect.try({
          try: () => new Uint8Array(crypto.sign(null, Buffer.from(req.data), privateKey)),
          catch: (cause) => new SignerError({ reason: "sign_failed", cause }),
        });
      });

    const publicKey: Signer["publicKey"] = (keyId: string) =>
      Effect.gen(function* () {
        const { publicKey: pub } = yield* getOrCreate(keyId);
        return yield* Effect.try({
          try: () => new Uint8Array(pub.export({ type: "spki", format: "der" })),
          catch: (cause) => new SignerError({ reason: "public_key_export_failed", cause }),
        });
      });

    return { sign, publicKey } satisfies Signer;
  }),
);
