import { people } from "@cloudable/schema";
import { HttpApiMiddleware, HttpApiSchema, HttpServerRequest } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { auth } from "../../auth";
import { Db } from "../../db/layer";
import { verifyCliToken } from "../../services/CliToken";

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
 * 401: no valid credential, or one whose subject has no matching `people`
 * row. The `status: 401` annotation is required here — unlike an endpoint's
 * own `.addError(Err, { status })`, a middleware failure has no per-endpoint
 * call site to carry the status, so it must live on the error schema itself;
 * without it, `HttpApiSchema.getStatusError` falls back to 500 for every
 * authentication failure.
 */
export class AuthenticationRequired extends Schema.TaggedError<AuthenticationRequired>()(
  "AuthenticationRequired",
  { reason: Schema.Literal("no_session", "no_matching_person", "invalid_token") },
  HttpApiSchema.annotations({ status: 401 }),
) {}

/**
 * Two credentials reach this middleware, and both resolve to the same
 * `CurrentUser`:
 *
 *   - **A BetterAuth session cookie** (see `../../auth.ts`), which is what
 *     the console sends. Read via BetterAuth's own `auth.api.getSession`,
 *     then resolved to a `people` row by email — `auth_user.email` and
 *     `people.email` are both globally unique specifically so this lookup is
 *     unambiguous (see `packages/schema/src/tables/person.ts`).
 *   - **An `Authorization: Bearer` CLI token** (see
 *     `../../services/CliToken.ts`), which is what `cloudable login` stores
 *     and every other `cloudable` command sends. Resolved to a `people` row
 *     by id.
 *
 * The bearer path is tried first and, when an `Authorization` header is
 * present, it is the *only* path: falling through to the cookie after a bad
 * token would report "no session" for what is really a bad token, and would
 * let a request carrying both credentials be authenticated as whichever one
 * happened to work.
 *
 * Either way the `people` row is read live, on every request. Neither
 * credential carries an org, a role or an email of its own, so neither can
 * outlive the person's current standing: offboarding deletes the row and the
 * next request fails, without waiting for a TTL.
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

/** `Authorization: Bearer <token>`, or undefined when the header is absent or is some other scheme. Exported for `auth.test.ts` — this is the branch that decides which credential a request is even claiming to carry. */
export const bearerToken = (headers: Readonly<Record<string, string>>): string | undefined => {
  const header = headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !value) return undefined;
  return value;
};

export const CurrentUserAuthenticationLive = Layer.effect(
  CurrentUserAuthentication,
  Effect.gen(function* () {
    // Captured here, at layer-construction time, not per-request — same
    // reasoning `http/handlers/tunnel.ts`'s `AccessAttachRouteLive` documents
    // for capturing `Db` this way: the router's own per-request ambient
    // context (`HttpRouter.Provided`) doesn't include `Db`.
    const db = yield* Db;

    const personById = (personId: string) =>
      Effect.tryPromise({
        try: () => db.select().from(people).where(eq(people.id, personId)).limit(1),
        catch: () => new AuthenticationRequired({ reason: "no_matching_person" }),
      });

    const personByEmail = (email: string) =>
      Effect.tryPromise({
        try: () => db.select().from(people).where(eq(people.email, email)).limit(1),
        catch: () => new AuthenticationRequired({ reason: "no_matching_person" }),
      });

    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      const token = bearerToken(request.headers);
      const rows = token
        ? yield* Effect.gen(function* () {
            const verified = verifyCliToken(token);
            if (!verified.ok) {
              return yield* Effect.fail(new AuthenticationRequired({ reason: "invalid_token" }));
            }
            return yield* personById(verified.personId);
          })
        : yield* Effect.gen(function* () {
            const session = yield* Effect.tryPromise({
              try: () => auth.api.getSession({ headers: new Headers(request.headers) }),
              catch: () => new AuthenticationRequired({ reason: "no_session" }),
            });
            if (!session) {
              return yield* Effect.fail(new AuthenticationRequired({ reason: "no_session" }));
            }
            return yield* personByEmail(session.user.email);
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
