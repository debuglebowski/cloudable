import { Effect, Layer } from "effect";
import { type SecretRef, type SecretsProvider, SecretsProviderTag } from "./SecretsProvider";

/**
 * Deterministic fake for tests/dev: returns a stable string derived from the
 * ref, never a real secret. Real per-provider implementations (Azure Key
 * Vault, 1Password) are unit 13's job.
 */
const service: SecretsProvider = {
  fetch: (ref: SecretRef) => Effect.succeed(`fake-secret:${ref.provider}:${ref.pointer}`),
};

export const FakeSecretsProviderLive = Layer.succeed(SecretsProviderTag, service);
