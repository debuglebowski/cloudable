import type { DomainEvent } from "@cloudable/events";
import { events, authSession, certificates, idpRoleMode, orgs, people } from "@cloudable/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import { toEventRows } from "../services/EventBus";
import { toDomainEvent } from "./audit";
import type { IdpRolesConfig } from "./config";
import { type AuditEvent, SERVICE } from "./contract";

// biome-ignore lint/suspicious/noExplicitAny: the schema type is irrelevant to these queries.
export type AnyPgDb = PgDatabase<PgQueryResultHKT, any>;

export const MODE_ROW_ID = "deployment";

export type ActivationOutcome =
  | { readonly kind: "unchanged" }
  | { readonly kind: "activated"; readonly reason: "enabled" | "config_changed"; readonly at: Date }
  | { readonly kind: "disabled"; readonly at: Date };

/**
 * Brings the persisted mode (`idp_role_mode`) in line with this process's config. Runs at
 * startup, before any request is answered in managed mode (`ensureActivation`).
 *
 * Only a real change acts, so restarts with unchanged config do nothing:
 *
 * - **Off → on, or the claim/mapping changed while on (a new epoch).** Every human credential
 *   ends: `people.credentials_revoked_at` moves to now (refuses every console session, CLI
 *   token and CLI sign-in code issued before), `idp_roles_verified_at` is cleared (every person
 *   needs a verified SSO sign-in under the new rules), console sessions are deleted, and live SSH
 *   certificates are marked revoked. Machine agent tokens are untouched: they are not human
 *   credentials. Open terminal, files and SSH tunnels close on the next sweep, because their
 *   owners' role evidence is gone (`tunnel/relay.ts`).
 * - **On → off.** Recorded; nothing is revoked. Roles stay as last set and admins manage them
 *   again.
 *
 * One transaction under a row lock, so two replicas starting together act once.
 */
export const reconcileActivation = async (
  db: AnyPgDb,
  idpRoles: IdpRolesConfig | null,
  now = new Date(),
): Promise<ActivationOutcome> => {
  const { outcome, audits } = await db.transaction(async (tx) => {
    await tx
      .insert(idpRoleMode)
      .values({ id: MODE_ROW_ID, enabled: false, configFingerprint: null, activatedAt: null })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(idpRoleMode)
      .where(eq(idpRoleMode.id, MODE_ROW_ID))
      .for("update");
    if (!row) throw new Error("idp_role_mode row vanished");

    let outcome: ActivationOutcome;
    if (idpRoles === null) {
      if (!row.enabled) return { outcome: { kind: "unchanged" } as const, audits: [] };
      await tx
        .update(idpRoleMode)
        .set({ enabled: false, configFingerprint: null, updatedAt: now })
        .where(eq(idpRoleMode.id, MODE_ROW_ID));
      outcome = { kind: "disabled", at: now };
    } else {
      if (row.enabled && row.configFingerprint === idpRoles.fingerprint) {
        return { outcome: { kind: "unchanged" } as const, audits: [] };
      }
      const reason = row.enabled ? "config_changed" : "enabled";
      await tx
        .update(idpRoleMode)
        .set({
          enabled: true,
          configFingerprint: idpRoles.fingerprint,
          activatedAt: now,
          updatedAt: now,
        })
        .where(eq(idpRoleMode.id, MODE_ROW_ID));
      await tx.update(people).set({ credentialsRevokedAt: now, idpRolesVerifiedAt: null });
      await tx.delete(authSession);
      await tx
        .update(certificates)
        .set({ revokedAt: now, revokedReason: "idp_roles_activation" })
        .where(and(isNull(certificates.revokedAt), gt(certificates.expiresAt, now)));
      outcome = { kind: "activated", reason, at: now };
    }

    // One record per org: the activation is deployment-wide, the audit log is per org.
    const allOrgs = await tx.select({ id: orgs.id }).from(orgs);
    const correlationId = ulid();
    const audits: AuditEvent[] = [];
    const rows: DomainEvent[] = [];
    for (const org of allOrgs) {
      const audit: AuditEvent = {
        event: "idp_roles.activation",
        service: SERVICE,
        actor: "deployment-config",
        subject: org.id,
        source: "activation",
        previousGrants: [],
        newGrants: [],
        reason: outcome.kind === "activated" ? outcome.reason : "disabled",
      };
      audits.push(audit);
      rows.push(
        toDomainEvent(audit, {
          orgId: org.id,
          actorType: "system",
          actorId: "deployment-config",
          correlationId,
          at: now,
        }),
      );
    }
    if (rows.length > 0) await tx.insert(events).values(toEventRows(rows));
    return { outcome, audits };
  });
  for (const audit of audits) {
    console.warn(`[security] idp-roles ${JSON.stringify(audit)}`);
  }
  return outcome;
};

/** The persisted mode row, for the sign-in fence and tests. */
export const readModeRow = async (db: AnyPgDb) => {
  const [row] = await db.select().from(idpRoleMode).where(eq(idpRoleMode.id, MODE_ROW_ID));
  return row;
};

let pending: Promise<ActivationOutcome> | undefined;

/**
 * Runs `reconcileActivation` once per process. The middleware awaits it in managed mode, so no
 * request is answered under a config whose activation has not been applied. A failure is not
 * cached: the next request tries again, and until then requests fail.
 */
export const ensureActivation = (db: AnyPgDb, idpRoles: IdpRolesConfig | null) => {
  if (!pending) {
    pending = reconcileActivation(db, idpRoles).catch((error) => {
      pending = undefined;
      throw error;
    });
  }
  return pending;
};

/** Tests only: forget the cached activation so the next call reconciles again. */
export const resetActivationForTest = () => {
  pending = undefined;
};
