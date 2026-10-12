import { isAdminRole } from "@cloudable/contracts";
import { people } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Db } from "../../db/layer";

/**
 * 403: the caller is not an admin. The reason is plain language the console and the CLI show as is.
 */
export class AdminRoleRequiredError extends Schema.TaggedError<AdminRoleRequiredError>()(
  "AdminRoleRequiredError",
  { reason: Schema.String },
) {}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Passes only for an active person of this org whose role is an admin role (`ADMIN_ROLES`).
 *
 * The role is read from the database on every call, never taken from the session or a token. A
 * person who is deactivated, removed or demoted loses admin on their next request, which is the
 * same rule the authentication middleware follows for the rest of a person's standing.
 */
export const requireAdmin = (
  personId: string,
  orgId: string,
  reason: string,
): Effect.Effect<void, AdminRoleRequiredError, Db> =>
  Effect.gen(function* () {
    // An id that is not a UUID is not a person. Refused rather than sent to the database, where it
    // would be a type error and not an answer.
    if (!UUID_PATTERN.test(personId)) {
      return yield* Effect.fail(new AdminRoleRequiredError({ reason }));
    }
    const db = yield* Db;
    const rows = yield* Effect.tryPromise(() =>
      db
        .select({ orgId: people.orgId, role: people.role, active: people.active })
        .from(people)
        .where(eq(people.id, personId))
        .limit(1),
    ).pipe(Effect.orDie);
    const person = rows[0];
    if (!person || person.orgId !== orgId || !person.active || !isAdminRole(person.role)) {
      return yield* Effect.fail(new AdminRoleRequiredError({ reason }));
    }
  });

/**
 * Whether a change of role needs an admin.
 *
 * Creating a person needs one only to hand out an admin role. Changing a person's role needs one
 * whenever the role actually changes, in either direction: a member who could demote the owners
 * would lock them out, and one who could promote themselves would make the admin check pointless.
 * Re-sending the role a person already has changes nothing, so it needs nothing.
 */
export const roleChangeNeedsAdmin = (input: {
  currentRole: string | null;
  nextRole: string;
}): boolean =>
  input.currentRole === null ? isAdminRole(input.nextRole) : input.currentRole !== input.nextRole;

/**
 * The check for adding a person. Anyone may add an ordinary member; giving an admin role takes an admin.
 */
export const requireAdminToCreateWithRole = (
  actor: { personId: string; orgId: string },
  nextRole: string,
): Effect.Effect<void, AdminRoleRequiredError, Db> =>
  roleChangeNeedsAdmin({ currentRole: null, nextRole })
    ? requireAdmin(actor.personId, actor.orgId, "Only an admin can give someone an admin role.")
    : Effect.void;

/**
 * The check for changing a role. `target` is the person being changed, or undefined when they do
 * not exist or are in another org, which the update itself then reports as not found.
 */
export const requireAdminToChangeRole = (
  actor: { personId: string; orgId: string },
  target: { orgId: string; role: string } | undefined,
  nextRole: string,
): Effect.Effect<void, AdminRoleRequiredError, Db> =>
  target !== undefined &&
  target.orgId === actor.orgId &&
  roleChangeNeedsAdmin({ currentRole: target.role, nextRole })
    ? requireAdmin(actor.personId, actor.orgId, "Only an admin can change someone's role.")
    : Effect.void;
