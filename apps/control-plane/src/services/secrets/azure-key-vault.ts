// ---------------------------------------------------------------------------
// Real Azure Key Vault `SecretsProvider` adapter (CLAUDE.md invariant #8:
// "Cloudable injects secrets, never stores them."). No Azure Key Vault
// account exists in this build (same situation as `Signer.azure.ts` /
// `ProvisioningService.azure.ts`), so the HTTP request construction and
// response parsing below are real, but there is no live token source to
// exercise it against — callers supply an `AzureKeyVaultAuthTokenProvider`,
// a fake one by default here, and a real deployment wires it to a
// managed-identity token source later. Tests exercise the real request
// shape against a local mock HTTP server (see the colocated test file).
// ---------------------------------------------------------------------------
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Layer } from "effect";
import { type SecretRef, type SecretsProvider, SecretsProviderTag } from "../SecretsProvider";

/**
 * Supplies a bearer token (`aud=https://vault.azure.net`) for Key Vault REST
 * calls. A real deployment wires this to a managed-identity / Azure AD token
 * source; nothing in this file ever holds or stores a credential itself.
 */
export interface AzureKeyVaultAuthTokenProvider {
  getToken(): Effect.Effect<string, Error>;
}

/**
 * Dev/test-only token source: no Azure account exists in this build. Never
 * wire this into a real deployment — it returns a fixed, non-functional
 * string, not a credential.
 */
export const fakeAzureKeyVaultAuthTokenProvider: AzureKeyVaultAuthTokenProvider = {
  getToken: () => Effect.succeed("fake-key-vault-token"),
};

// Stable, GA Key Vault data-plane API version. See task note: real deploys
// may pin a newer version later, but 7.4 is a valid, supported version.
const KEY_VAULT_API_VERSION = "7.4";

// A `SecretRef.pointer` for this provider is a full Key Vault secret URL:
//   https://<vault-name>.vault.azure.net/secrets/<secret-name>
//   https://<vault-name>.vault.azure.net/secrets/<secret-name>/<version>
// i.e. exactly the resource URL Key Vault's own REST API and SDKs use,
// minus the `api-version` query param (added by this adapter).
const SECRET_PATH_PATTERN = /^\/secrets\/[^/]+(\/[^/]+)?$/;

export const parseAzureKeyVaultPointer = (pointer: string): Effect.Effect<URL, Error> =>
  Effect.try({
    try: () => {
      const url = new URL(pointer);
      // Real Key Vault is https-only; http is accepted too so tests (and a
      // local emulator, e.g. the Azure Key Vault Emulator) can point at a
      // plain local mock server.
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error(`pointer must be an http(s):// URL, got: ${pointer}`);
      }
      if (!SECRET_PATH_PATTERN.test(url.pathname)) {
        throw new Error(
          `pointer must look like https://<vault>.vault.azure.net/secrets/<name>[/<version>], got: ${pointer}`,
        );
      }
      return url;
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`invalid azure_key_vault pointer: ${pointer}`, { cause }),
  });

// Shape of Key Vault's `GET /secrets/{name}` response body — only the field
// this adapter needs.
interface KeyVaultSecretBundle {
  value?: unknown;
}

const fetchSecret = (
  client: HttpClient.HttpClient,
  tokenProvider: AzureKeyVaultAuthTokenProvider,
  ref: SecretRef,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    if (ref.provider !== "azure_key_vault") {
      return yield* Effect.fail(
        new Error(`azure-key-vault provider cannot fetch a "${ref.provider}" ref`),
      );
    }

    const url = yield* parseAzureKeyVaultPointer(ref.pointer);
    url.searchParams.set("api-version", KEY_VAULT_API_VERSION);
    const token = yield* tokenProvider.getToken();

    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.acceptJson,
    );

    const response = yield* client
      .execute(request)
      .pipe(
        Effect.mapError(
          (cause) => new Error(`Key Vault request failed: ${cause.message}`, { cause }),
        ),
      );

    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => "<unreadable body>"));
      return yield* Effect.fail(new Error(`Key Vault returned HTTP ${response.status}: ${body}`));
    }

    const body = yield* response.json.pipe(
      Effect.mapError((cause) => new Error("Key Vault response was not valid JSON", { cause })),
    );
    const bundle = body as KeyVaultSecretBundle;
    if (typeof bundle.value !== "string") {
      return yield* Effect.fail(new Error("Key Vault response is missing a string `value` field"));
    }
    return bundle.value;
  });

/**
 * Builds an Azure Key Vault `SecretsProvider` Layer using the given token
 * source. Fully self-contained (bundles its own `FetchHttpClient`) so it
 * matches the `Layer.Layer<SecretsProviderTag>` shape `buildAppLive` expects
 * — swap it in for `secrets` in place of the fake or the 1Password adapter.
 */
export const makeAzureKeyVaultSecretsProvider = (
  tokenProvider: AzureKeyVaultAuthTokenProvider,
): Layer.Layer<SecretsProviderTag> =>
  Layer.effect(
    SecretsProviderTag,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const service: SecretsProvider = {
        fetch: (ref) => fetchSecret(client, tokenProvider, ref),
      };
      return service;
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Dev/build default: real HTTP request construction and response parsing
 * against a fake, non-functional token — see `fakeAzureKeyVaultAuthTokenProvider`.
 * Not for production use.
 */
export const AzureKeyVaultSecretsProviderLive = makeAzureKeyVaultSecretsProvider(
  fakeAzureKeyVaultAuthTokenProvider,
);
