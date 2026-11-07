import type { IdpRolesConfig } from "./config";

export type IdpRole = "owner" | "admin" | "member";

/** What one sign-in's claim says the person should be. */
export type IdpRoleDecision =
  | {
      readonly kind: "granted";
      readonly role: IdpRole;
      readonly approver: boolean;
      /** The claim values that mapped to something. Empty when `unmapped: member` let them in. */
      readonly matched: readonly string[];
    }
  | {
      readonly kind: "denied";
      /** Every value the claim carried, for the log line. */
      readonly values: readonly string[];
    };

/** Higher wins when a person holds several mapped roles at the IdP. */
const RANK: Record<IdpRole, number> = { member: 1, admin: 2, owner: 3 };

/**
 * The claim's values as a list. A SAML attribute arrives as one string when it has one value and
 * as an array when it has several; an OIDC claim is the same. Anything else carries no role.
 */
export const claimValues = (raw: unknown): string[] => {
  if (typeof raw === "string") return raw === "" ? [] : [raw];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string" && v !== "");
  return [];
};

/**
 * Maps claim values to a Cloudable role and approver flag.
 *
 * Matching is exact, like `ADMIN_ROLES`: `cloudable.admin` does not match `Cloudable.Admin`, so a
 * typo at the IdP can never grant anything. With several mapped roles the highest wins. The
 * approver flag is set when any value maps to `approver`, but on its own it is not a role: with
 * no mapped role the sign-in is denied (or a member, if the operator chose `unmapped: member`).
 */
export const resolveIdpRole = (
  values: readonly string[],
  config: IdpRolesConfig,
): IdpRoleDecision => {
  let role: IdpRole | undefined;
  let approver = false;
  const matched: string[] = [];
  for (const value of values) {
    const target = Object.hasOwn(config.mapping, value) ? config.mapping[value] : undefined;
    if (target === undefined) continue;
    matched.push(value);
    if (target === "approver") {
      approver = true;
    } else if (role === undefined || RANK[target] > RANK[role]) {
      role = target;
    }
  }
  if (role === undefined) {
    if (config.unmapped === "deny") return { kind: "denied", values };
    role = "member";
  }
  return { kind: "granted", role, approver, matched };
};
