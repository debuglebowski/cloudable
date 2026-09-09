import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { findAnyActiveIdpIntegration } from "../../domain/integrations/integrations";
import { isSamlProviderRegistered } from "../../services/IdpSsoService";
import { Api } from "../api";

export const AuthSsoStatusLive = HttpApiBuilder.group(Api, "authSsoStatus", (handlers) =>
  handlers.handle("get", () =>
    findAnyActiveIdpIntegration().pipe(
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
