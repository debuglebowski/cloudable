import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { SecretRef } from "../SecretsProvider";
import { SecretsProviderTag } from "../SecretsProvider";
import {
  type OnePasswordConnectAuthTokenProvider,
  makeOnePasswordSecretsProvider,
} from "./onepassword";

// A tiny local stub simulating 1Password Connect's
// `GET /v1/vaults/{vaultId}/items/{itemId}` response shape, per
// https://developer.1password.com/docs/connect/connect-api-reference/#items
let requests: Array<{ method: string; pathname: string; authorization: string | null }> = [];

const VAULT_ID = "vault-abc";
const ITEM_ID = "item-xyz";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    requests.push({
      method: req.method,
      pathname: url.pathname,
      authorization: req.headers.get("authorization"),
    });

    if (url.pathname === `/v1/vaults/${VAULT_ID}/items/${ITEM_ID}`) {
      return Response.json({
        id: ITEM_ID,
        vault: { id: VAULT_ID },
        category: "LOGIN",
        fields: [
          { id: "username", label: "username", value: "svc-account" },
          { id: "password", label: "password", value: "s3cr3t-value" },
        ],
      });
    }
    if (url.pathname === `/v1/vaults/${VAULT_ID}/items/no-fields`) {
      return Response.json({ id: "no-fields", vault: { id: VAULT_ID }, fields: [] });
    }
    if (url.pathname === `/v1/vaults/${VAULT_ID}/items/missing`) {
      return new Response("Item not found", { status: 404 });
    }
    return new Response("unexpected path", { status: 500 });
  },
});

afterAll(() => server.stop(true));

const tokenProvider: OnePasswordConnectAuthTokenProvider = {
  getToken: () => Effect.succeed("test-connect-token"),
};
const layer = makeOnePasswordSecretsProvider(tokenProvider);

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

describe("onepassword SecretsProvider", () => {
  test("issues a real Connect GET request with a bearer token, and matches the field by label", async () => {
    const value = await run({
      provider: "onepassword",
      pointer: `http://localhost:${server.port}/v1/vaults/${VAULT_ID}/items/${ITEM_ID}?field=password`,
    });

    expect(value).toBe("s3cr3t-value");
    const last = requests.at(-1);
    expect(last?.method).toBe("GET");
    expect(last?.pathname).toBe(`/v1/vaults/${VAULT_ID}/items/${ITEM_ID}`);
    expect(last?.authorization).toBe("Bearer test-connect-token");
  });

  test("matches the field by id as well as label", async () => {
    const value = await run({
      provider: "onepassword",
      pointer: `http://localhost:${server.port}/v1/vaults/${VAULT_ID}/items/${ITEM_ID}?field=username`,
    });
    expect(value).toBe("svc-account");
  });

  test("fails with a descriptive error on a non-2xx response", async () => {
    const error = await runFailure({
      provider: "onepassword",
      pointer: `http://localhost:${server.port}/v1/vaults/${VAULT_ID}/items/missing?field=password`,
    });
    expect(error.message).toContain("404");
  });

  test("fails when no field on the item matches", async () => {
    const error = await runFailure({
      provider: "onepassword",
      pointer: `http://localhost:${server.port}/v1/vaults/${VAULT_ID}/items/no-fields?field=password`,
    });
    expect(error.message).toContain("password");
  });

  test("fails on a pointer missing the required ?field= query param, without hitting the network", async () => {
    const before = requests.length;
    const error = await runFailure({
      provider: "onepassword",
      pointer: `http://localhost:${server.port}/v1/vaults/${VAULT_ID}/items/${ITEM_ID}`,
    });
    expect(error.message).toContain("field");
    expect(requests.length).toBe(before);
  });

  test("fails on a pointer that isn't a Connect item URL", async () => {
    const error = await runFailure({
      provider: "onepassword",
      pointer: `http://localhost:${server.port}/v1/vaults/${VAULT_ID}?field=password`,
    });
    expect(error).toBeInstanceOf(Error);
  });

  test("refuses to handle a ref for a different provider, without hitting the network", async () => {
    const before = requests.length;
    const error = await runFailure({ provider: "azure_key_vault", pointer: "kv-ref" });
    expect(error.message).toContain("azure_key_vault");
    expect(requests.length).toBe(before);
  });
});
