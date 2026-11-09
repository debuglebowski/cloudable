import { createHash } from "node:crypto";
import { CLOUDABLE_TARGETS, IdpRoleError, type RoleConfig, parseConfig } from "./contract";

/** The parts of the configured identity provider that decide whose assertions are trusted. */
export interface IdpTrust {
  readonly providerId: string;
  readonly entityId: string;
  readonly ssoUrl: string;
  readonly emailDomains: string;
  readonly certs: readonly string[];
}

/** Roles from the identity provider, switched on. `null` everywhere else means off. */
export interface IdpRolesConfig extends RoleConfig {
  readonly enabled: true;
  /**
   * SHA-256 of everything role evidence depends on: the claim name, the mapping, the recheck
   * interval, and the identity provider's identity and trust anchors (provider id, entity id, SSO
   * URL, email domains, signing certificates). Stored with the activation (`idp_role_mode`), so a
   * change to any of them is a new activation: every human credential ends and everyone signs in
   * again, so evidence from one provider or policy can never be reused under another. A routine
   * IdP certificate rollover is therefore also a (cheap) new activation: one SSO redirect each.
   */
  readonly fingerprint: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const fingerprintOf = (
  config: Pick<RoleConfig, "claim" | "mapping" | "intervalSec">,
  idp: IdpTrust,
): string => {
  const mapping = Object.keys(config.mapping)
    .sort()
    .map((key) => [key, [...(config.mapping[key] ?? [])].sort()]);
  return sha256(
    JSON.stringify({
      claim: config.claim,
      mapping,
      intervalSec: config.intervalSec,
      idp: {
        providerId: idp.providerId,
        entityId: idp.entityId,
        ssoUrl: idp.ssoUrl,
        emailDomains: idp.emailDomains,
        // Digests only: the fingerprint is stored and compared, never the certificates.
        certs: idp.certs.map(sha256).sort(),
      },
    }),
  );
};

/**
 * Reads the mode from the environment with the shared contract's `parseConfig`
 * (`IDP_ROLES_ENABLED`, `IDP_ROLE_CLAIM`, `IDP_ROLE_MAPPING`, `IDP_RECHECK_INTERVAL_SECONDS`;
 * legacy names such as `ROLES_FROM_IDP` and `IDP_ROLE_UNMAPPED` are refused there), then adds Cloudable's own startup rules:
 *
 * - The identity provider must be declared in deployment config (`IDP_METADATA_URL` +
 *   `IDP_SAML_CONFIG`). It is the one provider whose assertions are trusted to carry roles.
 * - `PASSWORD_SIGN_IN=on` is refused. A password sign-in carries no role evidence. With the
 *   mode on, password sign-in is forced off whatever else is set (`config.ts`).
 *
 * Throws `IdpRoleError` (`INVALID_IDP_ROLE_CONFIG`), which stops the process at startup.
 */
export const readIdpRolesConfig = (
  env: Readonly<Record<string, string | undefined>>,
  idp: IdpTrust | null,
): IdpRolesConfig | null => {
  const parsed = parseConfig(env, CLOUDABLE_TARGETS);
  if (!parsed.enabled) return null;
  if (idp === null) {
    throw new IdpRoleError(
      "INVALID_IDP_ROLE_CONFIG",
      "IDP_ROLES_ENABLED=true needs the identity provider declared in deployment config (IDP_METADATA_URL and IDP_SAML_CONFIG).",
    );
  }
  if (env.PASSWORD_SIGN_IN === "on") {
    throw new IdpRoleError(
      "INVALID_IDP_ROLE_CONFIG",
      "IDP_ROLES_ENABLED=true cannot be combined with PASSWORD_SIGN_IN=on: a password sign-in carries no role evidence.",
    );
  }
  return { ...parsed, enabled: true, fingerprint: fingerprintOf(parsed, idp) };
};
