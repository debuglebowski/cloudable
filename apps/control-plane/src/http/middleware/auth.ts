import { Context } from "effect";

/**
 * The authenticated caller, once a request has passed auth middleware.
 */
export interface CurrentUser {
  readonly personId: string;
  readonly orgId: string;
  readonly email: string;
}

export class CurrentUserTag extends Context.Tag("CurrentUser")<CurrentUserTag, CurrentUser>() {}

// TODO(auth feature unit): wire a real `HttpApiMiddleware` here that
// validates the BetterAuth session (see `../../auth.ts`) on each request —
// e.g. reading the session cookie via BetterAuth's session API and
// providing a real `CurrentUserTag` value, failing with 401 otherwise — then
// apply it to `Api` in `http/api.ts` via `.middleware(...)`.
//
// Left as a stub for now: wiring a real `HttpApiMiddleware.Tag` against
// BetterAuth's session API is a meaningful design decision (which endpoints
// require auth, how org scoping is derived, session vs. bearer token for
// the CLI/agent) better left to the feature unit that owns it.
//
// UNLIKE the health check, `GET /api/v1/evidence` (see `../../evidence/`)
// takes `orgId` as a caller-supplied query parameter with no check that the
// caller belongs to that org — a cross-tenant read once real orgs/auth
// exist. Wiring this middleware MUST also update
// `evidence/handler.ts` to scope every query to `CurrentUserTag.orgId`
// (rejecting or ignoring a mismatched `orgId` param) rather than trusting
// the query string.
