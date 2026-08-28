import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import {
  createPerson,
  listPeopleByOrg,
  type PersonRow,
  setPersonActive,
  updatePerson,
} from "../../domain/people/people";
import { Api } from "../api";

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
    .handle("list", ({ urlParams }) =>
      listPeopleByOrg(urlParams.orgId).pipe(
        Effect.map((rows) => ({ items: rows.map(toWire) })),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("create", ({ payload }) =>
      createPerson(payload).pipe(
        Effect.map(toWire),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("update", ({ path, payload }) =>
      updatePerson({ personId: path.id, ...payload }).pipe(
        Effect.map(toWire),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    )
    .handle("setActive", ({ path, payload }) =>
      setPersonActive({ personId: path.id, active: payload.active }).pipe(
        Effect.map(toWire),
        Effect.catchTag("PeopleDbError", (e) => Effect.die(e)),
      ),
    ),
);
