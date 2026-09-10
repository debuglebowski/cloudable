import { DefaultAzureCredential } from "@azure/identity";
import postgres from "postgres";
import { config } from "../config";

/**
 * The one place a Postgres client is constructed — `db/layer.ts`,
 * `../auth.ts` and `../migrate-on-boot.ts` all go through here so the
 * authentication mode is decided once, not three times.
 *
 * `DATABASE_AUTH_MODE=entra` swaps the connection string's password for a
 * short-lived Entra access token fetched with the container's managed
 * identity, so no database password exists anywhere (see
 * `infra/terraform/control-plane`'s Postgres `authentication` block).
 * `password` (the default) keeps the plain `DATABASE_URL` credential — what
 * local dev, `docker-compose.yml` and tests use.
 *
 * Note that switching a real deployment back to `password` is not a rollback
 * on its own: the Terraform module turns the server's password auth off when
 * it turns Entra auth on, so there is no password to fall back to. Recovering
 * from broken token auth is an infrastructure change, not an env-var flip.
 *
 * Why this works without touching module-load order: postgres.js accepts a
 * *function* for `password` and connects lazily, so the token is fetched per
 * connection rather than at construction. `auth.ts` can keep building its
 * client at module scope (it has to — BetterAuth needs a synchronous handle
 * there), and token expiry is handled for free, since every new connection
 * asks again. `DefaultAzureCredential` caches internally, so this is not a
 * network round trip per connection.
 */
const POSTGRES_ENTRA_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

type PostgresOptions = NonNullable<Parameters<typeof postgres>[1]>;

/** Lazy + memoized, same reasoning as `services/ProvisioningService.azure.ts`'s `getClients`: constructing this reaches for ambient Azure credentials, which don't exist (and aren't wanted) in local dev or tests. */
let credential: DefaultAzureCredential | undefined;
const entraAccessToken = async (): Promise<string> => {
  credential ??= new DefaultAzureCredential();
  const token = await credential.getToken(POSTGRES_ENTRA_SCOPE);
  if (!token) {
    throw new Error(
      `no Entra token for ${POSTGRES_ENTRA_SCOPE} — is the container's managed identity configured?`,
    );
  }
  return token.token;
};

export const openPostgres = (options?: PostgresOptions): ReturnType<typeof postgres> =>
  postgres(config.databaseUrl, {
    ...options,
    ...(config.databaseAuthMode === "entra" ? { password: entraAccessToken } : {}),
  });
