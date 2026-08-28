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
// the CLI/agent) better left to the feature unit that owns it. No endpoint
// currently requires `CurrentUserTag`.
//
// KNOWN GAP as of the `/api/v1/compliance/*` endpoints (unit 10): those take
// `orgId` as a plain, unauthenticated query param (see
// `http/routes/compliance.ts`) as a stopgap until this lands — any caller
// can currently read any org's compliance findings/exports by passing its
// id. Wiring auth here should scope those endpoints to the caller's own org
// (or add an explicit authz check) rather than trusting the param.
