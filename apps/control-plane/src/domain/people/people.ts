import type * as schema from "@cloudable/schema";
import { people } from "@cloudable/schema";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Data, Effect, Schema } from "effect";
import { Db } from "../../db/layer";

type DbHandle = PostgresJsDatabase<typeof schema>;

/**
 * Real backend for the People page (spec §20: "People is top-level and
 * fully editable" when SCIM is absent). Deliberately mirrors
 * `apps/console/src/api/people.ts`'s mock operations exactly —
 * `addPerson`/`updatePerson`/`setPersonActive` — since that mock was
 * written against the real `people` table's actual columns from the start,
 * just without anything real behind it yet.
 *
 * Every mutation here is a no-op error, not a silent no-op, against a
 * `source: "scim"` row: once SCIM is connected, synced fields are
 * read-only and driven by the IdP (spec §3), never by this API.
 */

export type PersonRow = typeof people.$inferSelect;

// Schema.TaggedError, not Data.TaggedError — these travel over HTTP via
// `.addError()` in routes/people.ts, which needs a schema-encodable error.
export class PersonNotFoundError extends Schema.TaggedError<PersonNotFoundError>()(
  "PersonNotFoundError",
  { personId: Schema.String },
) {}

export class PersonNotManuallyManagedError extends Schema.TaggedError<PersonNotManuallyManagedError>()(
  "PersonNotManuallyManagedError",
  { personId: Schema.String },
) {}

export class PersonAlreadyExistsError extends Schema.TaggedError<PersonAlreadyExistsError>()(
  "PersonAlreadyExistsError",
  { email: Schema.String },
) {}

// Never crosses HTTP (always Effect.die'd in the handler) — plain Data.TaggedError is fine.
export class PeopleDbError extends Data.TaggedError("PeopleDbError")<{
  reason: string;
  cause?: unknown;
}> {}

const dbTry = <A>(thunk: () => Promise<A>, reason: string): Effect.Effect<A, PeopleDbError> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => new PeopleDbError({ reason, cause }) });

export const listPeopleByOrg = (orgId: string): Effect.Effect<PersonRow[], PeopleDbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* dbTry(
      () => db.select().from(people).where(eq(people.orgId, orgId)),
      "list_people_failed",
    );
  });

// `orgId` scopes the lookup to that org — a person belonging to a
// DIFFERENT org resolves to the same `PersonNotFoundError` as one that
// doesn't exist, same non-leaking posture as everywhere else in this
// build (see e.g. `MachineService.fetchMachine`).
const findById = (
  db: DbHandle,
  personId: string,
  orgId: string,
): Effect.Effect<PersonRow, PeopleDbError | PersonNotFoundError> =>
  Effect.gen(function* () {
    const rows = yield* dbTry(
      () => db.select().from(people).where(eq(people.id, personId)).limit(1),
      "find_person_failed",
    );
    const row = rows[0];
    if (!row || row.orgId !== orgId)
      return yield* Effect.fail(new PersonNotFoundError({ personId }));
    return row;
  });

export interface CreatePersonInput {
  orgId: string;
  email: string;
  role: string;
}

export const createPerson = (
  input: CreatePersonInput,
): Effect.Effect<PersonRow, PeopleDbError | PersonAlreadyExistsError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const normalizedEmail = input.email.trim().toLowerCase();

    const existing = yield* dbTry(
      () =>
        db
          .select({ id: people.id })
          .from(people)
          .where(
            and(eq(people.orgId, input.orgId), sql`lower(${people.email}) = ${normalizedEmail}`),
          )
          .limit(1),
      "check_existing_person_failed",
    );
    if (existing.length > 0) {
      return yield* Effect.fail(new PersonAlreadyExistsError({ email: input.email }));
    }

    const rows = yield* dbTry(
      () =>
        db
          .insert(people)
          .values({
            orgId: input.orgId,
            email: input.email.trim(),
            role: input.role,
            source: "manual",
            active: true,
          })
          .returning(),
      "create_person_failed",
    );
    const row = rows[0];
    if (!row) return yield* Effect.fail(new PeopleDbError({ reason: "insert_returned_no_row" }));
    return row;
  });

export interface UpdatePersonInput {
  personId: string;
  orgId: string;
  email?: string | undefined;
  role?: string | undefined;
}

export const updatePerson = (
  input: UpdatePersonInput,
): Effect.Effect<
  PersonRow,
  PeopleDbError | PersonNotFoundError | PersonNotManuallyManagedError,
  Db
> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const existing = yield* findById(db, input.personId, input.orgId);
    if (existing.source !== "manual") {
      return yield* Effect.fail(new PersonNotManuallyManagedError({ personId: input.personId }));
    }

    const rows = yield* dbTry(
      () =>
        db
          .update(people)
          .set({
            ...(input.email !== undefined ? { email: input.email.trim() } : {}),
            ...(input.role !== undefined ? { role: input.role } : {}),
          })
          .where(eq(people.id, input.personId))
          .returning(),
      "update_person_failed",
    );
    const row = rows[0];
    if (!row) return yield* Effect.fail(new PersonNotFoundError({ personId: input.personId }));
    return row;
  });

export interface SetPersonActiveInput {
  personId: string;
  orgId: string;
  active: boolean;
}

export const setPersonActive = (
  input: SetPersonActiveInput,
): Effect.Effect<
  PersonRow,
  PeopleDbError | PersonNotFoundError | PersonNotManuallyManagedError,
  Db
> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const existing = yield* findById(db, input.personId, input.orgId);
    if (existing.source !== "manual") {
      return yield* Effect.fail(new PersonNotManuallyManagedError({ personId: input.personId }));
    }

    const rows = yield* dbTry(
      () =>
        db
          .update(people)
          .set({ active: input.active, deactivatedAt: input.active ? null : new Date() })
          .where(eq(people.id, input.personId))
          .returning(),
      "set_person_active_failed",
    );
    const row = rows[0];
    if (!row) return yield* Effect.fail(new PersonNotFoundError({ personId: input.personId }));
    return row;
  });
