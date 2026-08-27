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
   * Azure AD's published JWKS, used to verify Azure managed-identity IMDS
   * tokens (docs/spec.md §9). Azure AD's signing keys are shared across
   * tenants, so the "common" discovery endpoint's key set verifies a token
   * for any tenant — configurable so tests can point it at a local mock
   * JWKS server instead.
   */
  readonly managedIdentityJwksUrl: string;
  /** Expected `aud` claim on an IMDS-issued managed-identity token. */
  readonly managedIdentityAudience: string;
}

const readConfig = (): AppConfig => ({
  databaseUrl: process.env["DATABASE_URL"] ?? "postgres://cloudable:cloudable@localhost:5442/cloudable",
  port: Number(process.env["PORT"] ?? 3000),
  betterAuthSecret: process.env["BETTER_AUTH_SECRET"] ?? "dev-only-change-me",
  betterAuthUrl: process.env["BETTER_AUTH_URL"] ?? "http://localhost:3000",
  managedIdentityJwksUrl:
    process.env["MANAGED_IDENTITY_JWKS_URL"] ?? "https://login.microsoftonline.com/common/discovery/v2.0/keys",
  managedIdentityAudience: process.env["MANAGED_IDENTITY_AUDIENCE"] ?? "https://management.azure.com/",
});

/** Plain, synchronous config — safe to import from anywhere, Effect or not. */
export const config: AppConfig = readConfig();

export class AppConfigTag extends Context.Tag("AppConfig")<AppConfigTag, AppConfig>() {}

export const AppConfigLive = Layer.succeed(AppConfigTag, config);
