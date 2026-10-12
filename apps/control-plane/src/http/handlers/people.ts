import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  requireAdminToChangeRole,
  requireAdminToCreateWithRole,
} from "../../domain/people/authorization";
import {
  type PersonRow,
  createPerson,
  getPersonById,
  listPeopleByOrg,
  setPersonActive,
  updatePerson,
} from "../../domain/people/people";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

const toWire = (row: PersonRow) => ({
  id: row.id,
  orgId: row.orgId,
  email: row.email,
  source: row.source,
  active: row.active,
  role: row.role,
  createdAt: row.createdAt.toISOString(),
  deactivatedAt: row.deactivatedAt ? row.deactivatedAt.toISOString() : null,
});

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
        return yield* listPeopleByOrg(currentUser.orgId);
      }).pipe(
        Effect.map((rows) => ({ items: rows.map(toWire) })),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // Anyone may add a person as an ordinary member. Handing out an admin role takes an admin.
        yield* requireAdminToCreateWithRole(currentUser, payload.role);
        return yield* createPerson({ ...payload, orgId: currentUser.orgId });
      }).pipe(
        Effect.map(toWire),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("update", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // Changing a role needs an admin, in either direction. Without this, the admin check on
        // sensitive settings would stop nobody: a member could make themselves an owner first.
        // Sending the role a person already has is not a change.
        if (payload.role !== undefined) {
          const target = yield* getPersonById(path.id).pipe(
            Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
          );
          yield* requireAdminToChangeRole(currentUser, target, payload.role);
        }
        return yield* updatePerson({ personId: path.id, orgId: currentUser.orgId, ...payload });
      }).pipe(
        Effect.map(toWire),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("setActive", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* setPersonActive({
          personId: path.id,
          orgId: currentUser.orgId,
          active: payload.active,
        });
      }).pipe(
        Effect.map(toWire),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    ),
);
