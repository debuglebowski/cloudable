import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * Whether the login page should show "Sign in with SSO" at all, and which
 * `providerId` to send it to — read before any session/org is known, so
 * this can't be `GET /api/v1/integrations` (session-gated). No secret in
 * the response, just whether a SAML provider is connected — same posture as
 * `provisioning/capabilities`.
 */
const SsoProviderStatus = Schema.Struct({
  available: Schema.Boolean,
  providerId: Schema.NullOr(Schema.String),
  // Whether the login page should offer email and password at all (`config.passwordSignInEnabled`).
  passwordSignIn: Schema.Boolean,
  // Whether roles come from the identity provider (`config.idpRoles`). The console then shows
  // roles read-only. The API refuses changes either way; this only saves a doomed click.
  rolesFromIdp: Schema.Boolean,
});

export const AuthSsoStatusGroup = HttpApiGroup.make("authSsoStatus").add(
  HttpApiEndpoint.get("get", "/api/v1/auth/sso-provider").addSuccess(SsoProviderStatus),
);
