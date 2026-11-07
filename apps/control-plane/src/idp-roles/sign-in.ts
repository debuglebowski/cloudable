import { APIError } from "better-auth";
import { CONFIGURED_IDP_PROVIDER_ID } from "../config";
import type { IdpRolesConfig } from "./config";
import { type IdpRoleSyncInput, describeIdpRoleSync, syncRoleFromIdp } from "./sync";

/**
 * The key the role claim is copied to in the plugin's user info (`mapping.extraFields` on the
 * configured provider, see `auth.ts`). A name of our own, so it can never collide with a field
 * the plugin sets itself.
 */
export const IDP_ROLE_CLAIM_FIELD = "cloudableIdpRoleClaim";

/** Shown on the login page as `<code>: <description>` (`ssoErrorFromSearch`). */
const DENIED_DESCRIPTION =
  "You have no Cloudable role at your identity provider. Ask your administrator to assign one.";

/**
 * The refusal. A redirect, not a plain error: the SAML response arrives as a browser POST, so a
 * JSON error would leave the person on a raw error page. Thrown the same way the plugin throws
 * its own redirects (`ctx.redirect` is `new APIError("FOUND", ..., { location })`). It runs
 * before the plugin sets the session cookie, so the refused sign-in never gets one.
 */
const refuse = (loginUrl: string, code: string): never => {
  const url = new URL(loginUrl);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", DENIED_DESCRIPTION);
  throw new APIError("FOUND", undefined, new Headers({ location: url.toString() }));
};

/** The slice of `@better-auth/sso`'s `provisionUser` argument this reads. */
export interface ProvisionUserArgs {
  readonly user: { readonly id: string; readonly email: string };
  readonly userInfo: Record<string, unknown>;
  readonly provider: { readonly providerId: string };
}

/**
 * The `sso()` options that turn on roles from the IdP.
 *
 * `provisionUserOnEveryLogin` makes the hook run on every SSO sign-in, not only the first. That
 * is what makes a role taken away at the IdP go away here at the next sign-in. Cloudable has no
 * periodic re-check against the IdP (no SCIM): between sign-ins the role stays as the last
 * sign-in set it.
 *
 * Only the provider declared in deployment config is trusted to carry roles. A sign-in through
 * any other provider (one registered from the console) is refused outright.
 */
export const idpRoleProvisioning = (
  db: Parameters<typeof syncRoleFromIdp>[0],
  config: IdpRolesConfig,
  loginUrl: string,
) => ({
  provisionUserOnEveryLogin: true,
  provisionUser: async ({ user, userInfo, provider }: ProvisionUserArgs): Promise<void> => {
    const input: IdpRoleSyncInput = {
      email: user.email,
      authUserId: user.id,
      providerId: provider.providerId,
      claim: userInfo[IDP_ROLE_CLAIM_FIELD],
    };
    if (provider.providerId !== CONFIGURED_IDP_PROVIDER_ID) {
      console.warn(
        `[security] idp-role: sign-in refused for ${user.email}: provider ${provider.providerId} is not the one roles are taken from`,
      );
      return refuse(loginUrl, "role_provider_not_trusted");
    }
    const result = await syncRoleFromIdp(db, config, input);
    const line = describeIdpRoleSync(input, result);
    if (result.kind === "granted") {
      console.log(line);
      return;
    }
    console.warn(line);
    return refuse(loginUrl, "no_mapped_role");
  },
});
