import { Context, Layer } from "effect";

/**
 * Control-plane configuration, read once from `process.env` with sane dev
 * defaults (see `.env.example` at the repo root).
 *
 * Kept as a plain synchronous object rather than routed through Effect's
 * `Config` module: some consumers (e.g. `auth.ts`, which constructs a
 * BetterAuth instance at module-load time, outside any Effect run) need a
 * value before an Effect runtime exists at all. The same values are also
 * exposed as an `AppConfigTag`/`AppConfigLive` Effect service below, for
 * anything that prefers to depend on it through the layer graph.
 */
export interface AppConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly betterAuthSecret: string;
  readonly betterAuthUrl: string;
  /**
   * This control plane's own OIDC issuer URL (see `docs/cloud-auth.md`).
   * Used both as the `issuer` field of the discovery document and as the
   * `iss` claim of every minted federation token. Must be the exact,
   * publicly reachable URL a customer's Azure federated identity
   * credential is configured to trust.
   */
  readonly federationIssuerUrl: string;
  /**
   * `aud` claim on minted federation tokens. Defaults to
   * `api://AzureADTokenExchange` — the fixed audience Entra ID expects for
   * OIDC-based workload identity federation (matches what GitHub Actions,
   * Terraform Cloud, etc. use for the same mechanism).
   */
  readonly federationAudience: string;
}

const readConfig = (): AppConfig => {
  const port = Number(process.env.PORT ?? 3000);
  return {
    databaseUrl:
      process.env.DATABASE_URL ?? "postgres://cloudable:cloudable@localhost:5442/cloudable",
    port,
    betterAuthSecret: process.env.BETTER_AUTH_SECRET ?? "dev-only-change-me",
    betterAuthUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    federationIssuerUrl: process.env.FEDERATION_ISSUER_URL ?? `http://localhost:${port}`,
    federationAudience: process.env.FEDERATION_AUDIENCE ?? "api://AzureADTokenExchange",
  };
};

/** Plain, synchronous config — safe to import from anywhere, Effect or not. */
export const config: AppConfig = readConfig();

export class AppConfigTag extends Context.Tag("AppConfig")<AppConfigTag, AppConfig>() {}

export const AppConfigLive = Layer.succeed(AppConfigTag, config);
