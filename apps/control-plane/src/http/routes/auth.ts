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

export const AuthRouteLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    yield* router.all(
      "/api/auth/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const webRequest = yield* HttpServerRequest.toWeb(request);
        const response = yield* Effect.tryPromise(() => auth.handler(webRequest));
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
