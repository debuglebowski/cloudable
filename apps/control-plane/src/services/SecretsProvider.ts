import { Context, type Effect } from "effect";

export interface SecretRef {
  provider: "azure_key_vault" | "onepassword";
  pointer: string;
}

/**
 * Port for fetching secrets to inject into machines (CLAUDE.md invariant
 * #8: "Cloudable injects secrets, never stores them."). Implementations
 * must fetch on demand and never persist the returned value.
 */
export interface SecretsProvider {
  fetch(ref: SecretRef): Effect.Effect<string, Error>;
}

export class SecretsProviderTag extends Context.Tag("SecretsProvider")<
  SecretsProviderTag,
  SecretsProvider
>() {}
