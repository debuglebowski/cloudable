import { config } from "../config";

/**
 * Pure helpers for reading SAML federation metadata. Deliberately free of any
 * import of `../auth` — `IdpSsoService.ts` imports the BetterAuth instance,
 * and `auth.ts` needs these same helpers to build its config-declared
 * provider, so anything shared between them has to live outside both.
 */

/** Cheap shape check — enough to tell "this is a metadata document" from "this is an HTML error page", which is the realistic failure when someone pastes the wrong URL. */
export const looksLikeSamlMetadata = (xml: string): boolean =>
  xml.includes("EntityDescriptor") && xml.includes("<");

/**
 * `@better-auth/sso`'s SAML registration validates `entryPoint` as a
 * required, non-empty string regardless of whether `idpMetadata.metadata` is
 * also given (its own doc comment says the metadata XML's SSO endpoint takes
 * precedence over this value once both are present, but the field itself
 * still has to be filled in) — so the real SSO redirect URL is pulled
 * straight out of the fetched metadata's own `SingleSignOnService` element
 * rather than invented.
 */
export const entryPointFrom = (xml: string): string | undefined =>
  /<(?:\w+:)?SingleSignOnService\b[^>]*\bLocation="([^"]+)"/.exec(xml)?.[1];

/** This deployment's one SP identity — every registered provider shares it, matching the Okta-guide convention of using the SP metadata URL itself as `issuer`/entityID. */
export const spIssuer = (): string => `${config.betterAuthUrl}/api/auth/sso/saml2/sp/metadata`;
