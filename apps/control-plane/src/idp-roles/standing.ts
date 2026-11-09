import type { IdpRolesConfig } from "./config";
import { freshness } from "./contract";

export type StandingRefusal =
  | "deactivated"
  | "credentials_revoked"
  | "idp_reauthentication_required";

export interface PersonStanding {
  readonly active: boolean;
  readonly credentialsRevokedAt: Date | null;
  readonly idpRolesVerifiedAt: Date | null;
}

/**
 * Whether a credential issued at `issuedAtMs` still speaks for this person. The one check behind
 * every way in: a console session, a CLI token, and a CLI sign-in code at redemption
 * (`http/handlers/access.ts`), so none of them can be a way around the others.
 *
 * With roles from the identity provider on, the person's role must also rest on a verified SAML
 * assertion younger than the recheck interval (the shared contract's `freshness`). Activation
 * and a refused sign-in clear `idpRolesVerifiedAt`, so the only way back is a fresh SSO sign-in.
 */
export const checkStanding = (
  person: PersonStanding,
  issuedAtMs: number,
  nowMs: number,
  idpRoles: IdpRolesConfig | null,
): StandingRefusal | null => {
  if (!person.active) return "deactivated";
  if (person.credentialsRevokedAt !== null && issuedAtMs <= person.credentialsRevokedAt.getTime()) {
    return "credentials_revoked";
  }
  if (idpRoles !== null && !isRoleEvidenceFresh(person, nowMs, idpRoles)) {
    return "idp_reauthentication_required";
  }
  return null;
};

export const isRoleEvidenceFresh = (
  person: Pick<PersonStanding, "idpRolesVerifiedAt">,
  nowMs: number,
  idpRoles: IdpRolesConfig,
): boolean => {
  const verifiedAt = person.idpRolesVerifiedAt;
  return (
    freshness(
      Math.floor(nowMs / 1000),
      verifiedAt === null ? null : Math.floor(verifiedAt.getTime() / 1000),
      idpRoles.intervalSec,
    ) === "ok"
  );
};

/** When the person's current role evidence runs out, for credentials that should not outlive it. */
export const roleEvidenceDeadline = (
  person: Pick<PersonStanding, "idpRolesVerifiedAt">,
  idpRoles: IdpRolesConfig,
): Date | null =>
  person.idpRolesVerifiedAt === null
    ? null
    : new Date(person.idpRolesVerifiedAt.getTime() + idpRoles.intervalSec * 1000);
