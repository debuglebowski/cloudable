import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { SecretRef, SecretsProvider } from "../SecretsProvider";
import { SecretsProviderTag } from "../SecretsProvider";
import { FakeSecretsProviderLive } from "../SecretsProvider.fake";
import { injectSecretsForSession, secretRefKey } from "./inject";

const run = (bindings: ReadonlyArray<SecretRef>) =>
  Effect.runPromise(Effect.provide(injectSecretsForSession(bindings), FakeSecretsProviderLive));

describe("injectSecretsForSession", () => {
  test("fetches every binding and returns them keyed by provider:pointer", async () => {
    const bindings: SecretRef[] = [
      { provider: "azure_key_vault", pointer: "https://v.vault.azure.net/secrets/db-password" },
      {
        provider: "onepassword",
        pointer: "https://connect.example/v1/vaults/v/items/i?field=password",
      },
    ];

    const result = await run(bindings);

    expect(Object.keys(result).sort()).toEqual(bindings.map(secretRefKey).sort());
    for (const ref of bindings) {
      expect(result[secretRefKey(ref)]).toBe(`fake-secret:${ref.provider}:${ref.pointer}`);
    }
  });

  test("returns an empty map for no bindings, without invoking the provider", async () => {
    const result = await run([]);
    expect(result).toEqual({});
  });

  test("propagates a provider failure", async () => {
    const failingProvider: SecretsProvider = { fetch: () => Effect.fail(new Error("boom")) };
    const layer = Layer.succeed(SecretsProviderTag, failingProvider);

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.provide(
          injectSecretsForSession([{ provider: "azure_key_vault", pointer: "x" }]),
          layer,
        ),
      ),
    );
    expect(error.message).toBe("boom");
  });
});
