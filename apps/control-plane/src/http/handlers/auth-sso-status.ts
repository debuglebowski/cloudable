import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { CONFIGURED_IDP_PROVIDER_ID, config } from "../../config";
import { findAnyActiveIdpIntegration } from "../../domain/integrations/integrations";
import { isSamlProviderRegistered } from "../../services/IdpSsoService";
import { Api } from "../api";

export const AuthSsoStatusLive = HttpApiBuilder.group(Api, "authSsoStatus", (handlers) =>
  handlers.handle("get", () =>
    // A config-declared provider short-circuits the database entirely, and
    // has to: `defaultSSO` lives in BetterAuth's options, not in
    // `auth_sso_provider`, so `isSamlProviderRegistered` would look for a row
    // that deliberately does not exist and report no SSO available — leaving
    // the login page with no button on a deployment whose whole point is that
    // Terraform configured one.
    config.idpMetadataXml !== null
      ? Effect.succeed({ available: true, providerId: CONFIGURED_IDP_PROVIDER_ID })
      : findAnyActiveIdpIntegration().pipe(
          Effect.catchTag("IntegrationsDbError", (e) => Effect.die(e)),
          Effect.flatMap((row) =>
            row === undefined
              ? Effect.succeed({ available: false, providerId: null })
              : isSamlProviderRegistered(row.id).pipe(
                  Effect.map((registered) => ({
                    available: registered,
                    providerId: registered ? row.id : null,
                  })),
                ),
          ),
        ),
  ),
);
