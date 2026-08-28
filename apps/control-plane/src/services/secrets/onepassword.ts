// ---------------------------------------------------------------------------
// Real 1Password Connect `SecretsProvider` adapter (CLAUDE.md invariant #8:
// "Cloudable injects secrets, never stores them."). No 1Password Connect
// server exists in this build (same situation as `azure-key-vault.ts`), so
// the HTTP request construction and response parsing below are real, but
// there is no live Connect token to exercise it against — callers supply a
// `OnePasswordConnectAuthTokenProvider`, a fake one by default here. Tests
// exercise the real request shape against a local mock HTTP server.
// ---------------------------------------------------------------------------
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Layer } from "effect";
import { type SecretRef, type SecretsProvider, SecretsProviderTag } from "../SecretsProvider";

/**
 * Supplies a 1Password Connect API token for `Authorization: Bearer`. A real
 * deployment wires this to whatever securely holds the customer's Connect
 * token; nothing in this file ever holds or stores it beyond the call.
 */
export interface OnePasswordConnectAuthTokenProvider {
  getToken(): Effect.Effect<string, Error>;
}

/**
 * Dev/test-only token source: no 1Password Connect server exists in this
 * build. Never wire this into a real deployment.
 */
export const fakeOnePasswordConnectAuthTokenProvider: OnePasswordConnectAuthTokenProvider = {
  getToken: () => Effect.succeed("fake-connect-token"),
};

// A `SecretRef.pointer` for this provider is a 1Password Connect item URL
// (exactly `GET {serverURL}/v1/vaults/{vaultId}/items/{itemId}` — see
// https://developer.1password.com/docs/connect/connect-api-reference/)
// plus a required `field` query param naming which field on that item to
// read, e.g.:
//   https://connect.example.com/v1/vaults/<vaultId>/items/<itemId>?field=password
// `field` is matched against each field's `id` or `label` in the response.
const ITEM_PATH_PATTERN = /^\/v1\/vaults\/[^/]+\/items\/[^/]+$/;

export const parseOnePasswordPointer = (
  pointer: string,
): Effect.Effect<{ requestUrl: URL; field: string }, Error> =>
  Effect.try({
    try: () => {
      const url = new URL(pointer);
      if (!ITEM_PATH_PATTERN.test(url.pathname)) {
        throw new Error(
          `pointer must look like <connect-server>/v1/vaults/<vaultId>/items/<itemId>, got: ${pointer}`,
        );
      }
      const field = url.searchParams.get("field");
      if (!field) {
        throw new Error(
          `pointer is missing a required ?field=<label> query param, got: ${pointer}`,
        );
      }
      const requestUrl = new URL(url.toString());
      requestUrl.search = "";
      return { requestUrl, field };
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`invalid onepassword pointer: ${pointer}`, { cause }),
  });

// Shape of a 1Password Connect item's `fields[]` entry — only what this
// adapter needs. See https://developer.1password.com/docs/connect/connect-api-reference/#items
interface OnePasswordField {
  id?: unknown;
  label?: unknown;
  value?: unknown;
}
interface OnePasswordItem {
  fields?: unknown;
}

const fetchSecret = (
  client: HttpClient.HttpClient,
  tokenProvider: OnePasswordConnectAuthTokenProvider,
  ref: SecretRef,
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    if (ref.provider !== "onepassword") {
      return yield* Effect.fail(
        new Error(`onepassword provider cannot fetch a "${ref.provider}" ref`),
      );
    }

    const { requestUrl, field } = yield* parseOnePasswordPointer(ref.pointer);
    const token = yield* tokenProvider.getToken();

    const request = HttpClientRequest.get(requestUrl).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.acceptJson,
    );

    const response = yield* client
      .execute(request)
      .pipe(
        Effect.mapError(
          (cause) => new Error(`1Password Connect request failed: ${cause.message}`, { cause }),
        ),
      );

    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => "<unreadable body>"));
      return yield* Effect.fail(
        new Error(`1Password Connect returned HTTP ${response.status}: ${body}`),
      );
    }

    const body = yield* response.json.pipe(
      Effect.mapError(
        (cause) => new Error("1Password Connect response was not valid JSON", { cause }),
      ),
    );
    const item = body as OnePasswordItem;
    const fields = Array.isArray(item.fields) ? (item.fields as OnePasswordField[]) : [];
    const match = fields.find((f) => f.id === field || f.label === field);
    if (!match || typeof match.value !== "string") {
      return yield* Effect.fail(
        new Error(`1Password Connect item has no readable field matching "${field}"`),
      );
    }
    return match.value;
  });

/**
 * Builds a 1Password Connect `SecretsProvider` Layer using the given token
 * source. Fully self-contained (bundles its own `FetchHttpClient`) so it
 * matches the `Layer.Layer<SecretsProviderTag>` shape `buildAppLive` expects
 * — swap it in for `secrets` in place of the fake or the Key Vault adapter.
 */
export const makeOnePasswordSecretsProvider = (
  tokenProvider: OnePasswordConnectAuthTokenProvider,
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
 * against a fake, non-functional token — see
 * `fakeOnePasswordConnectAuthTokenProvider`. Not for production use.
 */
export const OnePasswordSecretsProviderLive = makeOnePasswordSecretsProvider(
  fakeOnePasswordConnectAuthTokenProvider,
);
