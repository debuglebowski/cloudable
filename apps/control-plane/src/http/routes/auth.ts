// ---------------------------------------------------------------------------
// Mounts BetterAuth's own handler (`../../auth.ts`) at `/api/auth/*` — sign-
// up/sign-in/sign-out/get-session, all of BetterAuth's own routing, none of
// it modeled as `HttpApiEndpoint`s here. Raw-mounted for the same reason
// `agent-wake.ts`/`http/handlers/tunnel.ts`'s websocket routes are: this
// isn't a single fixed path/method, it's BetterAuth's own sub-router,
// which only understands the Web-standard `Request`/`Response` pair its
// `auth.handler` function already speaks (see `apps/console/src/lib/
// auth-client.ts`'s doc comment, which references this file by name).
// Without this, no session can ever be established, and every endpoint
// behind `CurrentUserAuthentication` (`http/middleware/auth.ts`) is
// permanently unreachable.
// ---------------------------------------------------------------------------
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { auth } from "../../auth";

/**
 * Logs the reason a SAML sign-in was rejected.
 *
 * `@better-auth/sso` does not throw and does not log when it refuses an
 * assertion: it answers the assertion-consumer POST with a redirect whose
 * query string carries `?error=`. The browser then follows that redirect, the
 * console's route guard sends an unauthenticated visitor to /login, and the
 * reason is gone. From the outside a rejected assertion is indistinguishable
 * from never having attempted one — the identity provider reports a clean
 * sign-in, the container logs are silent, and no session or account row
 * appears. That cost hours of real debugging.
 *
 * Deliberately a wrapper around the response rather than a BetterAuth hook:
 * this holds true regardless of which internal path produced the redirect,
 * and survives a plugin upgrade rearranging its internals.
 */
const logSsoFailure = (request: Request, response: Response): Effect.Effect<void> =>
  Effect.sync(() => {
    if (response.status < 300 || response.status >= 400) return;
    const location = response.headers.get("location");
    if (!location) return;
    let error: string | null = null;
    let description: string | null = null;
    try {
      const params = new URL(location, request.url).searchParams;
      error = params.get("error");
      description = params.get("error_description");
    } catch {
      return; // an unparseable Location is not worth failing a request over
    }
    if (!error) return;
    console.error(
      `[sso] rejected: ${error}${description ? ` — ${description}` : ""} (${new URL(request.url).pathname})`,
    );
  });

export const AuthRouteLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    yield* router.all(
      "/api/auth/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise(() => auth.handler(webRequest));
        yield* logSsoFailure(webRequest, response);
        return HttpServerResponse.fromWeb(response);
      }).pipe(
        // BetterAuth's own handler failing outright (not a normal 4xx it
        // returns itself as a real Response, but the call throwing) is our
        // own infra breaking, not a meaningful outcome for the caller —
        // same treatment every other raw route in this codebase gives an
        // unexpected failure.
        Effect.catchAll(() => HttpServerResponse.empty({ status: 500 })),
      ),
    );
  }),
);
