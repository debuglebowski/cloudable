import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  type PersonRow,
  createPerson,
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
        return yield* createPerson({ ...payload, orgId: currentUser.orgId });
      }).pipe(
        Effect.map(toWire),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("update", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
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
