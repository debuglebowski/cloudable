import { createHash } from "node:crypto";
import { CLOUDABLE_TARGETS, IdpRoleError, type RoleConfig, parseConfig } from "./contract";

/** Roles from the identity provider, switched on. `null` everywhere else means off. */
export interface IdpRolesConfig extends RoleConfig {
  readonly enabled: true;
  /**
   * SHA-256 of the claim name and mapping. Stored with the activation (`idp_role_mode`), so a
   * change to either is a new activation: everyone signs in again under the new rules.
   */
  readonly fingerprint: string;
}

export const fingerprintOf = (config: Pick<RoleConfig, "claim" | "mapping">): string => {
  const mapping = Object.keys(config.mapping)
    .sort()
    .map((key) => [key, [...(config.mapping[key] ?? [])].sort()]);
  return createHash("sha256")
    .update(JSON.stringify({ claim: config.claim, mapping }))
    .digest("hex");
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
  idpConfigured: boolean,
): IdpRolesConfig | null => {
  const parsed = parseConfig(env, CLOUDABLE_TARGETS);
  if (!parsed.enabled) return null;
  if (!idpConfigured) {
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
  return { ...parsed, enabled: true, fingerprint: fingerprintOf(parsed) };
};
