import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { SecretRef } from "../SecretsProvider";
import { SecretsProviderTag } from "../SecretsProvider";
import {
  type AzureKeyVaultAuthTokenProvider,
  makeAzureKeyVaultSecretsProvider,
} from "./azure-key-vault";

// A tiny local stub simulating Azure Key Vault's `GET /secrets/{name}`
// response shape, per https://learn.microsoft.com/rest/api/keyvault/secrets.
let requests: Array<{
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  authorization: string | null;
}> = [];

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    requests.push({
      method: req.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      authorization: req.headers.get("authorization"),
    });

    if (url.pathname === "/secrets/db-password") {
      return Response.json({
        value: "s3cr3t-value",
        id: `${url.origin}/secrets/db-password/abc123`,
        attributes: { enabled: true },
      });
    }
    if (url.pathname === "/secrets/missing-value") {
      return Response.json({ id: `${url.origin}/secrets/missing-value/abc123` });
    }
    if (url.pathname === "/secrets/not-found") {
      return new Response("Secret not found", { status: 404 });
    }
    return new Response("unexpected path", { status: 500 });
  },
});

afterAll(() => server.stop(true));

const tokenProvider: AzureKeyVaultAuthTokenProvider = {
  getToken: () => Effect.succeed("test-token"),
};
const layer = makeAzureKeyVaultSecretsProvider(tokenProvider);

const run = (ref: SecretRef) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const provider = yield* SecretsProviderTag;
        return yield* provider.fetch(ref);
      }),
      layer,
    ),
  );

const runFailure = (ref: SecretRef) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const provider = yield* SecretsProviderTag;
        return yield* Effect.flip(provider.fetch(ref));
      }),
      layer,
    ),
  );

beforeAll(() => {
  requests = [];
});

describe("azure-key-vault SecretsProvider", () => {
  test("issues a real GET request with api-version and a bearer token, and parses `value`", async () => {
    const value = await run({
      provider: "azure_key_vault",
      pointer: `http://localhost:${server.port}/secrets/db-password`,
    });

    expect(value).toBe("s3cr3t-value");
    const last = requests.at(-1);
    expect(last?.method).toBe("GET");
    expect(last?.pathname).toBe("/secrets/db-password");
    expect(last?.searchParams.get("api-version")).toBe("7.4");
    expect(last?.authorization).toBe("Bearer test-token");
  });

  test("fails with a descriptive error on a non-2xx response", async () => {
    const error = await runFailure({
      provider: "azure_key_vault",
      pointer: `http://localhost:${server.port}/secrets/not-found`,
    });
    expect(error.message).toContain("404");
  });

  test("fails when the response body has no string `value`", async () => {
    const error = await runFailure({
      provider: "azure_key_vault",
      pointer: `http://localhost:${server.port}/secrets/missing-value`,
    });
    expect(error.message).toContain("value");
  });

  test("fails on a malformed pointer without hitting the network", async () => {
    const before = requests.length;
    const error = await runFailure({ provider: "azure_key_vault", pointer: "not-a-url" });
    expect(error).toBeInstanceOf(Error);
    expect(requests.length).toBe(before);
  });

  test("fails on a pointer that isn't a Key Vault secret URL", async () => {
    const error = await runFailure({
      provider: "azure_key_vault",
      pointer: `http://localhost:${server.port}/keys/some-key`,
    });
    expect(error.message).toContain("secrets");
  });

  test("refuses to handle a ref for a different provider, without hitting the network", async () => {
    const before = requests.length;
    const error = await runFailure({ provider: "onepassword", pointer: "op-ref" });
    expect(error.message).toContain("onepassword");
    expect(requests.length).toBe(before);
  });
});
