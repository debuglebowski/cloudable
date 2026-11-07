import type { DomainEvent } from "@cloudable/events";
import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ulid } from "ulid";
import { config } from "../../config";
import { NotPermittedError, isApproverOrAdmin, requireAdminUser } from "../../domain/authz";
import {
  type PersonRow,
  createPerson,
  getPersonById,
  listPeopleByOrg,
  setPersonActive,
  updatePerson,
} from "../../domain/people/people";
import { EventBus } from "../../services/EventBus";
import { Api } from "../api";
import { type CurrentUser, CurrentUserTag } from "../middleware/auth";

const toWire = (row: PersonRow) => ({
  id: row.id,
  orgId: row.orgId,
  email: row.email,
  source: row.source,
  active: row.active,
  role: row.role,
  approver: row.approver,
  createdAt: row.createdAt.toISOString(),
  deactivatedAt: row.deactivatedAt ? row.deactivatedAt.toISOString() : null,
});

/** A `person.*` event about `subject`, by the signed-in admin. `machineId` is null: these are about a person. */
const personEvent = <T extends DomainEvent["type"]>(
  actor: CurrentUser,
  correlationId: string,
  type: T,
  payload: Extract<DomainEvent, { type: T }>["payload"],
): DomainEvent =>
  ({
    // Overwritten by `EventBus.publish`, which assigns the real id and recordedAt.
    id: "",
    recordedAt: new Date(0),
    occurredAt: new Date(),
    orgId: actor.orgId,
    actorType: "person",
    actorId: actor.personId,
    machineId: null,
    correlationId,
    schemaVersion: 1,
    type,
    payload,
  }) as DomainEvent;

/** What an in-tool role change gets when roles come from the identity provider. */
export const ROLES_MANAGED_BY_IDP =
  "Roles are managed by your identity provider. Change the role there; it applies at the person's next sign-in.";

/**
 * Refuses a role or approver change when the operator turned on roles from the IdP
 * (`config.idpRoles`), and logs the attempt. A no-op otherwise. Read per call, not captured, so
 * tests can flip the mode.
 */
const refuseIfRolesFromIdp = (
  actor: CurrentUser,
  attempt: { readonly personId?: string; readonly role?: string; readonly approver?: boolean },
) =>
  Effect.gen(function* () {
    if (config.idpRoles === null) return;
    if (attempt.role === undefined && attempt.approver === undefined) return;
    const asked = [
      attempt.role !== undefined ? `role=${attempt.role}` : null,
      attempt.approver !== undefined ? `approver=${attempt.approver}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    console.warn(
      `[security] idp-role: refused in-tool role change by ${actor.email} (person ${actor.personId}) for ${attempt.personId ?? "a new person"}: ${asked}`,
    );
    return yield* Effect.fail(new NotPermittedError({ reason: ROLES_MANAGED_BY_IDP }));
  });

const publish = (events: DomainEvent[]) =>
  events.length === 0
    ? Effect.void
    : Effect.flatMap(EventBus, (bus) => bus.publish(events)).pipe(Effect.orDie);

export const PeopleLive = HttpApiBuilder.group(Api, "people", (handlers) =>
  handlers
    .handle("me", () =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const row = yield* getPersonById(currentUser.personId);
        // The middleware resolved this id from a live `people` row moments
        // ago, so a miss here means the row was deleted mid-request. Dying is
        // right: it is not a 404 the caller can act on.
        if (!row) {
          return yield* Effect.die(
            new Error(`person ${currentUser.personId} vanished between auth and handler`),
          );
        }
        return toWire(row);
      }).pipe(Effect.catchTag("PeopleDbError", (e) => Effect.die(e))),
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const rows = yield* listPeopleByOrg(currentUser.orgId);
        // Admins run the roster; approvers need names to judge requests. A member gets only
        // themselves, which is all the console ever shows them.
        return isApproverOrAdmin(currentUser)
          ? rows
          : rows.filter((row) => row.id === currentUser.personId);
      }).pipe(
        Effect.map((rows) => ({ items: rows.map(toWire) })),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // With roles from the IdP a new person starts as a member; their first sign-in sets the
        // real role. Asking for anything else is a role change.
        yield* refuseIfRolesFromIdp(currentUser, {
          ...(payload.role !== "member" ? { role: payload.role } : {}),
        });
        yield* requireAdminUser(currentUser, "Only an admin can add a person.");
        const row = yield* createPerson({ ...payload, orgId: currentUser.orgId });
        yield* publish([
          personEvent(currentUser, ulid(), "person.added", { email: row.email, source: "manual" }),
        ]);
        return row;
      }).pipe(
        Effect.map(toWire),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("update", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* refuseIfRolesFromIdp(currentUser, {
          personId: path.id,
          ...(payload.role !== undefined ? { role: payload.role } : {}),
          ...(payload.approver !== undefined ? { approver: payload.approver } : {}),
        });
        // Email, role and the approver flag are all admin's to change. Email above all: the
        // console resolves a sign-in to a person by email, so whoever can change it can make
        // their own sign-in arrive as someone else.
        yield* requireAdminUser(currentUser, "Only an admin can change a person.");
        if (path.id === currentUser.personId && payload.role !== undefined) {
          const self = yield* getPersonById(path.id);
          if (self && self.role !== payload.role) {
            return yield* Effect.fail(
              new NotPermittedError({ reason: "Ask another admin to change your own role." }),
            );
          }
        }
        const before = yield* getPersonById(path.id);
        const row = yield* updatePerson({
          personId: path.id,
          orgId: currentUser.orgId,
          ...payload,
        });
        const correlationId = ulid();
        const events: DomainEvent[] = [];
        if (before && before.email !== row.email) {
          events.push(
            personEvent(currentUser, correlationId, "person.email_changed", {
              previous: before.email,
              current: row.email,
            }),
          );
        }
        if (before && before.role !== row.role) {
          events.push(
            personEvent(currentUser, correlationId, "person.role_changed", {
              previous: before.role,
              current: row.role,
            }),
          );
        }
        if (before && before.approver !== row.approver) {
          events.push(
            personEvent(currentUser, correlationId, "person.approver_changed", {
              previous: before.approver,
              current: row.approver,
            }),
          );
        }
        yield* publish(events);
        return row;
      }).pipe(
        Effect.map(toWire),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("setActive", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        yield* requireAdminUser(
          currentUser,
          "Only an admin can deactivate or reactivate a person.",
        );
        if (path.id === currentUser.personId && !payload.active) {
          return yield* Effect.fail(
            new NotPermittedError({ reason: "Ask another admin to deactivate you." }),
          );
        }
        const before = yield* getPersonById(path.id);
        const row = yield* setPersonActive({
          personId: path.id,
          orgId: currentUser.orgId,
          active: payload.active,
        });
        if (before && before.active !== row.active) {
          yield* publish([
            row.active
              ? personEvent(currentUser, ulid(), "person.activated", {})
              : personEvent(currentUser, ulid(), "person.deactivated", { source: row.source }),
          ]);
        }
        return row;
      }).pipe(
        Effect.map(toWire),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    ),
);
