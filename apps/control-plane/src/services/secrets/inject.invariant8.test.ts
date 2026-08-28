// Explicit test for CLAUDE.md invariant #8 ("Cloudable injects secrets,
// never stores them.") on the fetch-and-inject path: spy on every
// disk-write primitive Bun/Node expose and run a full fetch-and-inject
// cycle through `injectSecretsForSession`, asserting none of them were ever
// called.
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { Effect } from "effect";
import type { SecretRef } from "../SecretsProvider";
import { FakeSecretsProviderLive } from "../SecretsProvider.fake";
import { injectSecretsForSession } from "./inject";

describe("invariant #8: secrets are injected, never stored", () => {
  test("a full fetch-and-inject cycle makes zero disk-write calls", async () => {
    const writeFileSyncSpy = spyOn(fs, "writeFileSync");
    const appendFileSyncSpy = spyOn(fs, "appendFileSync");
    const writeFileSpy = spyOn(fsPromises, "writeFile");
    const appendFileSpy = spyOn(fsPromises, "appendFile");
    const bunWriteSpy = spyOn(Bun, "write");

    const bindings: SecretRef[] = [
      {
        provider: "azure_key_vault",
        pointer: "https://v.vault.azure.net/secrets/very-secret-value",
      },
      {
        provider: "onepassword",
        pointer: "https://connect.example/v1/vaults/v/items/i?field=password",
      },
    ];

    try {
      const result = await Effect.runPromise(
        Effect.provide(injectSecretsForSession(bindings), FakeSecretsProviderLive),
      );

      // Sanity: the cycle actually fetched real (fake-provider) values —
      // this isn't a vacuous "nothing happened" pass.
      expect(Object.values(result).length).toBe(bindings.length);
      for (const value of Object.values(result)) {
        expect(value.startsWith("fake-secret:")).toBe(true);
      }

      expect(writeFileSyncSpy).not.toHaveBeenCalled();
      expect(appendFileSyncSpy).not.toHaveBeenCalled();
      expect(writeFileSpy).not.toHaveBeenCalled();
      expect(appendFileSpy).not.toHaveBeenCalled();
      expect(bunWriteSpy).not.toHaveBeenCalled();
    } finally {
      writeFileSyncSpy.mockRestore();
      appendFileSyncSpy.mockRestore();
      writeFileSpy.mockRestore();
      appendFileSpy.mockRestore();
      bunWriteSpy.mockRestore();
    }
  });
});
