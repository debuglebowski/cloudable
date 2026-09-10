// ---------------------------------------------------------------------------
// SECURITY: this file and `Signer.local.ts` are the ONLY two files anywhere
// in this codebase allowed to touch raw key material (CLAUDE.md invariant
// #9: "The CA private key never enters the control plane. Sign operations
// only."). Do not import `node:crypto` key APIs, or read/write key files,
// from anywhere else — go through the `Signer` port instead.
//
// This adapter is what actually satisfies that invariant: it never sees key
// material at all. Key Vault generates the key inside the vault, exposes it
// only through /sign and /verify, and this file calls those two endpoints
// plus a public-key read. There is deliberately no import/export path here —
// if a future change needs one, that change is the invariant breaking, not a
// detail.
// ---------------------------------------------------------------------------
import { DefaultAzureCredential } from "@azure/identity";
import { Effect, Layer } from "effect";
import { type SignRequest, type Signer, SignerError, SignerTag } from "./Signer";

/** Stable, GA Key Vault data-plane API version — same one `services/secrets/azure-key-vault.ts` pins. */
const KEY_VAULT_API_VERSION = "7.4";
const KEY_VAULT_SCOPE = "https://vault.azure.net/.default";

/**
 * ES256 is P-256 + SHA-256. It's the only algorithm this signer offers,
 * matching `Signer.local.ts`, so dev and production produce byte-identical
 * signatures. Key Vault has no Ed25519 at all (RSA, EC P-256/256K/384/521,
 * oct) — that constraint is why the SSH CA and session-token keys are P-256
 * rather than Ed25519 throughout.
 */
const SIGN_ALGORITHM = "ES256";

/** Key Vault signs a *digest*, not the message — the caller hashes first. */
const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("sha256").update(data).digest());

const base64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url").replace(/=+$/, "");

const fromBase64Url = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64url"));

/**
 * Real Key Vault-backed `Signer`. `keyVaultUri` is the vault's data-plane URI
 * (e.g. `https://my-vault.vault.azure.net/`); a `keyId` from the `Signer`
 * port names a key inside it, so the two SSH/session keys live as two keys in
 * one vault.
 *
 * Authenticates with `DefaultAzureCredential` — the same ambient
 * managed-identity path `ProvisioningService.azure.ts` uses, so no credential
 * is stored here either (invariant #1).
 */
export const makeAzureSigner = (keyVaultUri: string): Signer => {
  // Lazy + memoized, same reasoning as `db/connect.ts` and
  // `ProvisioningService.azure.ts`: constructing this reaches for ambient
  // Azure credentials that don't exist in local dev or tests.
  let credential: DefaultAzureCredential | undefined;

  const request = (
    keyId: string,
    operation: "sign" | "verify" | "",
    body?: unknown,
  ): Effect.Effect<Record<string, unknown>, SignerError> =>
    Effect.tryPromise({
      try: async () => {
        credential ??= new DefaultAzureCredential();
        const token = await credential.getToken(KEY_VAULT_SCOPE);
        if (!token) throw new Error(`no Key Vault token for ${KEY_VAULT_SCOPE}`);

        const base = keyVaultUri.endsWith("/") ? keyVaultUri : `${keyVaultUri}/`;
        const suffix = operation === "" ? "" : `/${operation}`;
        // No key version in the path: Key Vault resolves an empty version to
        // the key's current version, so rotating the key in the vault is
        // picked up without a redeploy.
        const url = `${base}keys/${encodeURIComponent(keyId)}/${suffix}?api-version=${KEY_VAULT_API_VERSION}`;

        const response = await fetch(url, {
          method: body ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${token.token}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          throw new Error(`Key Vault ${operation || "get"} failed: ${response.status}`);
        }
        return (await response.json()) as Record<string, unknown>;
      },
      catch: (cause) => new SignerError({ reason: "key_vault_request_failed", cause }),
    });

  const sign: Signer["sign"] = (req: SignRequest) =>
    Effect.gen(function* () {
      if (req.algorithm !== "ecdsa-sha2-nistp256") {
        return yield* Effect.fail(
          new SignerError({
            reason: "unsupported_algorithm",
            cause: `azure signer only supports ecdsa-sha2-nistp256 (Key Vault ES256), got: ${req.algorithm}`,
          }),
        );
      }
      const result = yield* request(req.keyId, "sign", {
        alg: SIGN_ALGORITHM,
        value: base64Url(sha256(req.data)),
      });
      const value = result.value;
      if (typeof value !== "string") {
        return yield* Effect.fail(
          new SignerError({ reason: "sign_failed", cause: "no signature in Key Vault response" }),
        );
      }
      // ES256 comes back as fixed-width r||s (64 bytes) — exactly what
      // `openssh-cert.ts`'s signature encoder and the session-token verifier
      // expect, and why `Signer.local.ts` uses "ieee-p1363" to match.
      const signature = fromBase64Url(value);
      if (signature.length !== 64) {
        return yield* Effect.fail(
          new SignerError({
            reason: "sign_failed",
            cause: `expected a 64-byte ES256 signature, got ${signature.length}`,
          }),
        );
      }
      return signature;
    });

  /**
   * Returns the key's public half as SPKI DER, the shape the `Signer` port
   * promises and `rawP256PointFromSpki` consumes. Key Vault returns a JWK
   * (base64url x and y), so the SPKI wrapper is rebuilt around the point —
   * this is public key material only; nothing here can export a private key,
   * and Key Vault would refuse to if asked.
   */
  const publicKey: Signer["publicKey"] = (keyId: string) =>
    Effect.gen(function* () {
      const result = yield* request(keyId, "");
      const key = result.key as { x?: string; y?: string; crv?: string } | undefined;
      if (!key?.x || !key?.y) {
        return yield* Effect.fail(
          new SignerError({
            reason: "public_key_export_failed",
            cause: "Key Vault response had no EC public point",
          }),
        );
      }
      if (key.crv !== "P-256") {
        return yield* Effect.fail(
          new SignerError({
            reason: "public_key_export_failed",
            cause: `expected a P-256 key, got curve ${key.crv}`,
          }),
        );
      }
      const x = fromBase64Url(key.x);
      const y = fromBase64Url(key.y);
      if (x.length !== 32 || y.length !== 32) {
        return yield* Effect.fail(
          new SignerError({
            reason: "public_key_export_failed",
            cause: `expected 32-byte P-256 coordinates, got ${x.length}/${y.length}`,
          }),
        );
      }
      // Fixed 26-byte P-256 SPKI prefix (SEQUENCE, ecPublicKey + prime256v1
      // OIDs, BIT STRING header), then the uncompressed point — the exact
      // inverse of `rawP256PointFromSpki`.
      const spkiPrefix = Uint8Array.from([
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
        0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
      ]);
      const spki = new Uint8Array(spkiPrefix.length + 65);
      spki.set(spkiPrefix, 0);
      spki.set([0x04], spkiPrefix.length);
      spki.set(x, spkiPrefix.length + 1);
      spki.set(y, spkiPrefix.length + 33);
      return spki;
    });

  return { sign, publicKey } satisfies Signer;
};

export const AzureSignerLive = (keyVaultUri: string): Layer.Layer<SignerTag> =>
  Layer.succeed(SignerTag, makeAzureSigner(keyVaultUri));
