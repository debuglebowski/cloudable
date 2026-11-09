import type { DomainEvent } from "@cloudable/events";
import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ulid } from "ulid";
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
        yield* requireAdminUser(currentUser, "Only an admin can add a person.");
        const row = yield* createPerson({ ...payload, orgId: currentUser.orgId });
        yield* publish([
          personEvent(currentUser, ulid(), "person.added", {
            email: row.email,
            source: "manual",
            personId: row.id,
            role: row.role,
            approver: row.approver,
          }),
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
              personId: row.id,
              previous: before.role,
              current: row.role,
            }),
          );
        }
        if (before && before.approver !== row.approver) {
          events.push(
            personEvent(currentUser, correlationId, "person.approver_changed", {
              personId: row.id,
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
              ? personEvent(currentUser, ulid(), "person.activated", {
                  personId: row.id,
                  role: row.role,
                  approver: row.approver,
                })
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
