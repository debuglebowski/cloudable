import type { DomainEvent } from "@cloudable/events";
import { events, authSession, certificates, idpRoleMode, people } from "@cloudable/schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { toEventRows } from "../services/EventBus";
import { type AnyPgDb, MODE_ROW_ID } from "./activation";
import { toDomainEvent } from "./audit";
import type { IdpRolesConfig } from "./config";
import { type AuditEvent, SERVICE, resolveGrants } from "./contract";
import { decideCloudableRole, grantsOf } from "./precedence";

/**
 * The AuthnRequest lifetime (`@better-auth/sso` `saml.requestTTL`, set in `auth.ts`): how long a
 * request this deployment issued stays answerable. A signed assertion must answer one, and be at
 * most this old by its own IssueInstant (`saml-assertion.ts`).
 */
export const SAML_REQUEST_TTL_MS = 5 * 60 * 1000;

export interface VerifiedAssertion {
  /** The signed-in person's email, as the identity provider asserted it. */
  readonly email: string;
  /** The BetterAuth user that just signed in. */
  readonly authUserId: string;
  /** The provider the assertion came from. Recorded as the actor. */
  readonly providerId: string;
  /** The raw role attribute from the assertion: a string, an array of strings, or absent. */
  readonly claim: unknown;
  /** The verified assertion's own signed IssueInstant (`checkFreshAssertion`). Recorded as the
   * time of the role evidence. */
  readonly assertionIssuedAt: Date;
}

export type SyncResult =
  | {
      readonly kind: "granted" | "denied";
      readonly personId: string;
      readonly orgId: string;
      readonly audit: AuditEvent;
    }
  | { readonly kind: "no_person" }
  | { readonly kind: "mode_mismatch" }
  | { readonly kind: "stale_evidence" };

/**
 * Applies one verified SAML assertion to the person it names, in one transaction with the audit
 * record.
 *
 * Fenced against activation: the persisted mode must be on with this process's exact claim and
 * mapping. A replica still running older config (mid-deploy) refuses rather than writes roles
 * under rules that are no longer in force.
 *
 * Granted: role and approver flag become what the claim says, and `idp_roles_verified_at` moves
 * forward (never back). Denied (no mapped role, or no usable claim): role back to member, flag
 * off, role evidence cleared, and every credential ends: `credentials_revoked_at` (console
 * sessions, CLI tokens, CLI sign-in codes), the console sessions themselves, and live SSH
 * certificates. The caller then refuses the sign-in.
 */
export const applyVerifiedAssertion = async (
  db: AnyPgDb,
  config: IdpRolesConfig,
  input: VerifiedAssertion,
): Promise<SyncResult> => {
  const targets = resolveGrants({ [config.claim]: input.claim }, config);
  const decision = decideCloudableRole(targets);
  const email = input.email.trim().toLowerCase();
  const now = new Date();

  return db.transaction(async (tx) => {
    const [mode] = await tx
      .select()
      .from(idpRoleMode)
      .where(eq(idpRoleMode.id, MODE_ROW_ID))
      .for("share");
    if (!mode?.enabled || mode.configFingerprint !== config.fingerprint || !mode.activatedAt) {
      return { kind: "mode_mismatch" } as const;
    }

    const [person] = await tx
      .select()
      .from(people)
      .where(sql`lower(${people.email}) = ${email}`)
      .limit(1)
      .for("update");
    if (!person) return { kind: "no_person" } as const;

    const previousGrants = grantsOf(person);
    const correlationId = ulid();
    const batch: DomainEvent[] = [];
    const envelope = {
      orgId: person.orgId,
      actorType: "idp" as const,
      actorId: input.providerId,
      correlationId,
      at: now,
    };

    // Evidence only moves forward. An assertion counts only if it was issued strictly after
    // the current activation epoch and after the person's last credential revocation (a refused
    // sign-in, an email change, the activation itself): an assertion the IdP signed for a
    // request made before either is from a world that has since been revoked, even if it
    // arrives inside its 5 minutes. Nor may it be older than the evidence already recorded.
    const cutoff = Math.max(
      mode.activatedAt.getTime(),
      person.credentialsRevokedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    );
    if (
      input.assertionIssuedAt.getTime() <= cutoff ||
      (person.idpRolesVerifiedAt && input.assertionIssuedAt < person.idpRolesVerifiedAt)
    ) {
      return { kind: "stale_evidence" } as const;
    }

    let audit: AuditEvent;
    let next: { role: string; approver: boolean };
    if (decision.kind === "granted") {
      next = { role: decision.role, approver: decision.approver };
      const verifiedAt = input.assertionIssuedAt;
      await tx
        .update(people)
        .set({ ...next, idpRolesVerifiedAt: verifiedAt })
        .where(eq(people.id, person.id));
      const newGrants = grantsOf(next);
      const unchanged =
        person.idpRolesVerifiedAt !== null && previousGrants.join() === newGrants.join();
      audit = {
        event: unchanged ? "idp_roles.revalidated" : "idp_roles.granted",
        service: SERVICE,
        actor: input.providerId,
        subject: person.id,
        source: "saml",
        previousGrants,
        newGrants,
        reason: "verified",
      };
    } else {
      next = { role: "member", approver: false };
      await tx
        .update(people)
        .set({ ...next, idpRolesVerifiedAt: null, credentialsRevokedAt: now })
        .where(eq(people.id, person.id));
      await tx.delete(authSession).where(eq(authSession.userId, input.authUserId));
      await tx
        .update(certificates)
        .set({ revokedAt: now, revokedReason: "idp_roles_denied" })
        .where(
          and(
            eq(certificates.personId, person.id),
            isNull(certificates.revokedAt),
            gt(certificates.expiresAt, now),
          ),
        );
      audit = {
        event: "idp_roles.denied",
        service: SERVICE,
        actor: input.providerId,
        subject: person.id,
        source: "saml",
        previousGrants,
        newGrants: [],
        reason: targets.length === 0 ? "no_mapped_role" : "no_role_only_approver",
      };
    }

    // The long-standing person events, so existing readers of the audit trail see the change too.
    if (person.role !== next.role) {
      batch.push({
        ...toDomainEvent(audit, envelope),
        type: "person.role_changed",
        payload: { previous: person.role, current: next.role },
      } as DomainEvent);
    }
    if (person.approver !== next.approver) {
      batch.push({
        ...toDomainEvent(audit, envelope),
        type: "person.approver_changed",
        payload: { previous: person.approver, current: next.approver },
      } as DomainEvent);
    }
    batch.push(toDomainEvent(audit, envelope));
    await tx.insert(events).values(toEventRows(batch));

    return {
      kind: decision.kind,
      personId: person.id,
      orgId: person.orgId,
      audit,
    } as const;
  });
};
