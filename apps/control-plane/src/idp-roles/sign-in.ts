import { authUser, people } from "@cloudable/schema";
import { APIError } from "better-auth";
import { eq, sql } from "drizzle-orm";
import { CONFIGURED_IDP_PROVIDER_ID } from "../config";
import type { AnyPgDb } from "./activation";
import { logAudit } from "./audit";
import type { IdpRolesConfig } from "./config";
import { checkFreshAssertion, currentAssertionFacts } from "./saml-assertion";
import { applyVerifiedAssertion } from "./sync";

/**
 * The key the role attribute is copied to in the plugin's user info (`mapping.extraFields` on
 * the configured provider, see `auth.ts`). A name of our own, so it never collides with a field
 * the plugin sets itself.
 *
 * Copying one attribute by its exact name is the shared contract's claim resolution for SAML:
 * SAML attributes are a flat map of string or string-array values, so the contract's dotted-path
 * fallback can never match anything the exact name would not.
 */
export const IDP_ROLE_CLAIM_FIELD = "cloudableIdpRoleClaim";

const DESCRIPTIONS: Record<string, string> = {
  no_mapped_role:
    "You have no Cloudable role at your identity provider. Ask your administrator to assign one.",
  role_provider_not_trusted: "Sign in through your organisation's identity provider.",
  no_matching_person: "No Cloudable person exists for this account. Ask an org admin.",
  idp_roles_config_changed: "Cloudable is restarting with new sign-in settings. Try again shortly.",
  saml_assertion_rejected:
    "Your identity provider's sign-in could not be used as proof of your role. Sign in again.",
};

/**
 * The refusal: a redirect to the login page, not a plain error, because the SAML response
 * arrives as a browser POST. Thrown the way the plugin throws its own redirects. It runs before
 * the plugin sets the session cookie, so a refused sign-in never gets one.
 */
const refuse = (loginUrl: string, code: keyof typeof DESCRIPTIONS): never => {
  const url = new URL(loginUrl);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", DESCRIPTIONS[code] ?? code);
  throw new APIError("FOUND", undefined, new Headers({ location: url.toString() }));
};

/** Deletes a sign-in account that has no person behind it. Its sessions and SSO links go with it. */
const removeAccountWithoutPerson = async (db: AnyPgDb, userId: string, email: string) => {
  const normalized = email.trim().toLowerCase();
  const [person] = await db
    .select({ id: people.id })
    .from(people)
    .where(sql`lower(${people.email}) = ${normalized}`)
    .limit(1);
  if (person) return;
  await db.delete(authUser).where(eq(authUser.id, userId));
};

/** The slice of `@better-auth/sso`'s `provisionUser` argument this reads. */
export interface ProvisionUserArgs {
  readonly user: { readonly id: string; readonly email: string };
  readonly userInfo: Record<string, unknown>;
  readonly provider: { readonly providerId: string };
}

/**
 * The `sso()` options for roles from the identity provider.
 *
 * `provisionUserOnEveryLogin`: every verified SAML sign-in, not only the first, sets the role.
 * That is also how the hourly recheck works for SAML: once the role evidence is older than the
 * interval, every request is refused until the person signs in through SSO again
 * (`standing.ts`), and that sign-in is a new verified assertion.
 *
 * Only the provider declared in deployment config carries roles. Any other is refused.
 */
export const idpRoleProvisioning = (
  db: AnyPgDb,
  config: IdpRolesConfig,
  loginUrl: string,
  /** The provider's email domains. A first sign-in from one of them, with a role, adds the person. */
  autoAddDomains?: ReadonlyArray<string>,
) => ({
  provisionUserOnEveryLogin: true,
  provisionUser: async ({ user, userInfo, provider }: ProvisionUserArgs): Promise<void> => {
    if (provider.providerId !== CONFIGURED_IDP_PROVIDER_ID) {
      console.warn(
        `[security] idp-roles sign-in refused: provider ${provider.providerId} is not the one roles are taken from`,
      );
      return refuse(loginUrl, "role_provider_not_trusted");
    }
    // The plugin has verified the assertion's signature, audience, recipient and the outer
    // InResponseTo by now. What it does not check is that the signed assertion itself answers
    // that request, and how old it is: `checkFreshAssertion` does, from the assertion's own
    // signed fields. Its IssueInstant becomes the time of the role evidence.
    const fresh = checkFreshAssertion(currentAssertionFacts(), Date.now());
    if (!fresh.ok) {
      console.warn(`[security] idp-roles sign-in refused: ${fresh.reason}`);
      return refuse(loginUrl, "saml_assertion_rejected");
    }
    const result = await applyVerifiedAssertion(db, config, {
      email: user.email,
      authUserId: user.id,
      providerId: provider.providerId,
      claim: userInfo[IDP_ROLE_CLAIM_FIELD],
      assertionIssuedAt: fresh.issuedAt,
      ...(autoAddDomains ? { autoAddDomains } : {}),
    });
    if (result.kind === "stale_evidence") {
      console.warn("[security] idp-roles sign-in refused: assertion older than recorded evidence");
      return refuse(loginUrl, "saml_assertion_rejected");
    }
    if (result.kind === "no_person") {
      console.warn("[security] idp-roles sign-in refused: no person for the signed-in account");
      // The account may have been created just for this sign-in (auto-add, `auth.ts`). With no
      // person it could never be used, so it goes: no account without a person.
      await removeAccountWithoutPerson(db, user.id, user.email);
      return refuse(loginUrl, "no_matching_person");
    }
    if (result.kind === "mode_mismatch") {
      console.warn("[security] idp-roles sign-in refused: persisted mode does not match config");
      return refuse(loginUrl, "idp_roles_config_changed");
    }
    logAudit(result.audit);
    if (result.kind === "denied") return refuse(loginUrl, "no_mapped_role");
  },
});
