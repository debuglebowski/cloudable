import type { DomainEvent } from "@cloudable/events";
import { events, authSession, people } from "@cloudable/schema";
import { eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ulid } from "ulid";
import { toEventRows } from "../services/EventBus";
import type { IdpRolesConfig } from "./config";
import { type IdpRoleDecision, claimValues, resolveIdpRole } from "./resolve";

// Any Drizzle Postgres handle: `auth.ts`'s schema-less one and the tests' full-schema one.
// biome-ignore lint/suspicious/noExplicitAny: the schema type is irrelevant to these queries.
type AnyPgDb = PgDatabase<PgQueryResultHKT, any>;

export interface IdpRoleSyncInput {
  /** The signed-in person's email, as the identity provider asserted it. */
  readonly email: string;
  /** The BetterAuth user that just signed in. Its sessions end on a denied sign-in. */
  readonly authUserId: string;
  /** The provider the assertion came from. Recorded as the events' actor. */
  readonly providerId: string;
  /** The raw claim from the assertion: a string, an array of strings, or absent. */
  readonly claim: unknown;
}

export type IdpRoleSyncResult =
  | {
      readonly kind: "granted" | "denied";
      readonly decision: IdpRoleDecision;
      readonly personId: string;
      readonly orgId: string;
      readonly previous: { readonly role: string; readonly approver: boolean };
      readonly current: { readonly role: string; readonly approver: boolean };
    }
  | { readonly kind: "no_person" };

/**
 * Sets a person's role and approver flag from one sign-in's role claim, in one transaction with
 * the events that record it.
 *
 * Granted: the role and flag become what the claim says. Taking a role away at the IdP takes it
 * away here at the next sign-in.
 *
 * Denied (no mapped role): the person becomes a member with no approver flag, and every
 * credential they hold ends. `credentialsRevokedAt` refuses every console session and CLI token
 * issued up to now, the same field an email change uses; the session rows go too. The caller
 * then refuses this sign-in, so no cookie is ever set.
 *
 * Changes are recorded as `person.role_changed` / `person.approver_changed` with actor type
 * `idp`, so an auditor can tell them from an admin's change. An unchanged sign-in writes nothing.
 */
export const syncRoleFromIdp = async (
  db: AnyPgDb,
  config: IdpRolesConfig,
  input: IdpRoleSyncInput,
): Promise<IdpRoleSyncResult> => {
  const decision = resolveIdpRole(claimValues(input.claim), config);
  const email = input.email.trim().toLowerCase();

  return db.transaction(async (tx) => {
    const [person] = await tx
      .select()
      .from(people)
      .where(sql`lower(${people.email}) = ${email}`)
      .limit(1)
      .for("update");
    if (!person) return { kind: "no_person" } as const;

    const previous = { role: person.role, approver: person.approver };
    const current =
      decision.kind === "granted"
        ? { role: decision.role, approver: decision.approver }
        : { role: "member", approver: false };
    const now = new Date();

    await tx
      .update(people)
      .set({
        role: current.role,
        approver: current.approver,
        ...(decision.kind === "denied" ? { credentialsRevokedAt: now } : {}),
      })
      .where(eq(people.id, person.id));

    if (decision.kind === "denied") {
      await tx.delete(authSession).where(eq(authSession.userId, input.authUserId));
    }

    const correlationId = ulid();
    const event = <T extends "person.role_changed" | "person.approver_changed">(
      type: T,
      payload: Extract<DomainEvent, { type: T }>["payload"],
    ): DomainEvent =>
      ({
        // Replaced by `toEventRows`.
        id: "",
        recordedAt: now,
        occurredAt: now,
        orgId: person.orgId,
        actorType: "idp",
        actorId: input.providerId,
        machineId: null,
        correlationId,
        schemaVersion: 1,
        type,
        payload,
      }) as DomainEvent;

    // Both are tier 1, the compliance floor, so no logging-tier filter applies.
    const batch: DomainEvent[] = [];
    if (previous.role !== current.role) {
      batch.push(event("person.role_changed", { previous: previous.role, current: current.role }));
    }
    if (previous.approver !== current.approver) {
      batch.push(
        event("person.approver_changed", {
          previous: previous.approver,
          current: current.approver,
        }),
      );
    }
    if (batch.length > 0) await tx.insert(events).values(toEventRows(batch));

    return {
      kind: decision.kind,
      decision,
      personId: person.id,
      orgId: person.orgId,
      previous,
      current,
    } as const;
  });
};

/**
 * The security log line for one sign-in's role. One line per sign-in, granted or denied, so the
 * container log shows every role Cloudable took from the IdP even when nothing changed.
 */
export const describeIdpRoleSync = (input: IdpRoleSyncInput, result: IdpRoleSyncResult): string => {
  if (result.kind === "no_person") {
    return `[security] idp-role: sign-in refused, no person for ${input.email} (provider ${input.providerId})`;
  }
  const values = claimValues(input.claim);
  const was = `was ${result.previous.role}${result.previous.approver ? "+approver" : ""}`;
  if (result.decision.kind === "denied") {
    return `[security] idp-role: sign-in refused for ${input.email} (person ${result.personId}): no mapped role in claim [${values.join(", ")}]; set to member, credentials revoked (${was})`;
  }
  const now = `${result.current.role}${result.current.approver ? "+approver" : ""}`;
  const from =
    result.decision.matched.length > 0
      ? `from [${result.decision.matched.join(", ")}]`
      : `by default, claim [${values.join(", ")}] has no mapped role`;
  return `[security] idp-role: ${input.email} (person ${result.personId}) is ${now} ${from} (${was})`;
};
