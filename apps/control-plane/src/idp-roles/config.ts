/**
 * Roles from the identity provider: the operator's opt-in to let the IdP decide every person's
 * role and approver flag at sign-in. Off by default. See `docs/access.md`, "Roles from the
 * identity provider".
 *
 * Pure parsing only, so `config.ts` can call it at module load and tests can call it directly.
 */

/** What a claim value can map to. `approver` is the flag on top of a role, not a role. */
export type IdpRoleTarget = "owner" | "admin" | "member" | "approver";

const TARGETS: readonly IdpRoleTarget[] = ["owner", "admin", "member", "approver"];

export interface IdpRolesConfig {
  /**
   * The assertion attribute (SAML) or token claim (OIDC) that carries the person's roles.
   * Matched by exact name.
   */
  readonly claim: string;
  /** Claim value to Cloudable role, matched exactly and case-sensitively. */
  readonly mapping: Readonly<Record<string, IdpRoleTarget>>;
  /**
   * What happens when no claim value maps to a role. `deny` (the default) refuses the sign-in
   * and ends every session the person holds. `member` lets them in as a member.
   */
  readonly unmapped: "deny" | "member";
}

/**
 * The role attribute Microsoft identity providers (Entra ID, AD FS) put in a SAML assertion.
 * SAML has no single standard name for it; this is the one most providers ship or can be told to
 * use. An OIDC provider would use `roles`, but Cloudable signs people in through SAML only.
 */
export const DEFAULT_SAML_ROLE_CLAIM =
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";

/** Reads `ROLES_FROM_IDP`, `IDP_ROLE_CLAIM`, `IDP_ROLE_MAPPING`, `IDP_ROLE_UNMAPPED`, `PASSWORD_SIGN_IN`. */
export type IdpRolesEnv = Readonly<Record<string, string | undefined>>;

/**
 * Reads the mode from the environment. `null` means off, which is the default and leaves every
 * role in Cloudable's own hands.
 *
 * Refuses to start rather than half-enable: when the operator asked for IdP roles, a typo in the
 * mapping must stop the process, not quietly leave roles editable in the console.
 *
 * `idpConfigured` is whether deployment config declares the SAML identity provider. The mode
 * needs it, because that is the one provider whose assertions are trusted to carry roles. It also
 * refuses `PASSWORD_SIGN_IN=on`: a password sign-in carries no claim, so it would sign a person in
 * on whatever role they last had.
 */
export const parseIdpRolesConfig = (
  env: IdpRolesEnv,
  idpConfigured: boolean,
): IdpRolesConfig | null => {
  const mode = env.ROLES_FROM_IDP ?? "";
  if (mode === "" || mode === "off") return null;
  if (mode !== "on") throw new Error(`ROLES_FROM_IDP must be "on" or "off", got "${mode}".`);

  if (!idpConfigured) {
    throw new Error(
      "ROLES_FROM_IDP=on needs the identity provider declared in deployment config (IDP_METADATA_URL and IDP_SAML_CONFIG).",
    );
  }
  if (env.PASSWORD_SIGN_IN === "on") {
    throw new Error(
      "ROLES_FROM_IDP=on cannot be combined with PASSWORD_SIGN_IN=on: a password sign-in carries no role claim.",
    );
  }

  const claim = (env.IDP_ROLE_CLAIM ?? "").trim() || DEFAULT_SAML_ROLE_CLAIM;

  const rawMapping = env.IDP_ROLE_MAPPING ?? "";
  if (rawMapping.trim() === "") {
    throw new Error(
      'ROLES_FROM_IDP=on needs IDP_ROLE_MAPPING, JSON like {"Cloudable.Admin":"admin","Cloudable.Member":"member"}.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMapping);
  } catch (cause) {
    throw new Error(`IDP_ROLE_MAPPING is not valid JSON: ${String(cause)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("IDP_ROLE_MAPPING must be a JSON object of claim value to role.");
  }
  const mapping: Record<string, IdpRoleTarget> = {};
  for (const [value, target] of Object.entries(parsed)) {
    if (value === "") throw new Error("IDP_ROLE_MAPPING has an empty claim value.");
    if (typeof target !== "string" || !TARGETS.includes(target as IdpRoleTarget)) {
      throw new Error(
        `IDP_ROLE_MAPPING maps "${value}" to "${String(target)}". Use one of: ${TARGETS.join(", ")}.`,
      );
    }
    mapping[value] = target as IdpRoleTarget;
  }
  if (Object.keys(mapping).length === 0) {
    throw new Error("IDP_ROLE_MAPPING is empty.");
  }

  const unmapped = env.IDP_ROLE_UNMAPPED ?? "";
  if (unmapped !== "" && unmapped !== "deny" && unmapped !== "member") {
    throw new Error(`IDP_ROLE_UNMAPPED must be "deny" or "member", got "${unmapped}".`);
  }

  return { claim, mapping, unmapped: unmapped === "member" ? "member" : "deny" };
};
