import { people } from "@cloudable/schema";
import { HttpApiMiddleware, HttpApiSchema, HttpServerRequest } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { auth } from "../../auth";
import { Db } from "../../db/layer";

/**
 * The authenticated caller, once a request has passed auth middleware.
 */
export interface CurrentUser {
  readonly personId: string;
  readonly orgId: string;
  readonly email: string;
}

export class CurrentUserTag extends Context.Tag("CurrentUser")<CurrentUserTag, CurrentUser>() {}

/**
 * 401: no valid BetterAuth session, or the session's email has no matching
 * `people` row. The `status: 401` annotation is required here — unlike an
 * endpoint's own `.addError(Err, { status })`, a middleware failure has no
 * per-endpoint call site to carry the status, so it must live on the error
 * schema itself; without it, `HttpApiSchema.getStatusError` falls back to
 * 500 for every authentication failure.
 */
export class AuthenticationRequired extends Schema.TaggedError<AuthenticationRequired>()(
  "AuthenticationRequired",
  { reason: Schema.Literal("no_session", "no_matching_person") },
  HttpApiSchema.annotations({ status: 401 }),
) {}

/**
 * Real session auth (see `../../auth.ts`'s BetterAuth instance): reads the
 * request's session cookie via BetterAuth's own `auth.api.getSession`, then
 * resolves that session's user to a `people` row by email — `auth_user.email`
 * and `people.email` are both globally unique specifically so this lookup is
 * unambiguous (see `packages/schema/src/tables/person.ts`'s doc comment).
 *
 * Apply via `.middleware(CurrentUserAuthentication)` on an `HttpApiGroup`/
 * `HttpApiEndpoint` — every handler downstream can then `yield* CurrentUserTag`
 * for the real, authenticated org/person, no unauthenticated `orgId`/`personId`
 * query param needed. A raw-mounted route (a websocket upgrade, which can't
 * use `HttpApiEndpoint`'s `.middleware()` at all) instead runs this manually:
 * `const authenticate = yield* CurrentUserAuthentication; const user = yield*
 * authenticate;` (see `http/handlers/tunnel.ts`'s `AccessAttachRouteLive`).
 */
export class CurrentUserAuthentication extends HttpApiMiddleware.Tag<CurrentUserAuthentication>()(
  "CurrentUserAuthentication",
  {
    failure: AuthenticationRequired,
    provides: CurrentUserTag,
  },
) {}

export const CurrentUserAuthenticationLive = Layer.effect(
  CurrentUserAuthentication,
  Effect.gen(function* () {
    // Captured here, at layer-construction time, not per-request — same
    // reasoning `http/handlers/tunnel.ts`'s `AccessAttachRouteLive` documents
    // for capturing `Db` this way: the router's own per-request ambient
    // context (`HttpRouter.Provided`) doesn't include `Db`.
    const db = yield* Db;

    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      const session = yield* Effect.tryPromise({
        try: () => auth.api.getSession({ headers: new Headers(request.headers) }),
        catch: () => new AuthenticationRequired({ reason: "no_session" }),
      });
      if (!session) {
        return yield* Effect.fail(new AuthenticationRequired({ reason: "no_session" }));
      }

      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(people).where(eq(people.email, session.user.email)).limit(1),
        catch: () => new AuthenticationRequired({ reason: "no_matching_person" }),
      });
      const person = rows[0];
      if (!person) {
        return yield* Effect.fail(new AuthenticationRequired({ reason: "no_matching_person" }));
      }

      return {
        personId: person.id,
        orgId: person.orgId,
        email: person.email,
      } satisfies CurrentUser;
    });
  }),
);
