import { elevations, machines, people, settingValues } from "@cloudable/schema";
import type { SettingRow } from "@cloudable/schema";
import { and, eq, inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Db } from "../../db/layer";
import { type ElevationRepo, ElevationRepoTag } from "./ElevationRepo";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** `INSERT ... RETURNING` / `UPDATE ... RETURNING` by primary key always returns exactly one row. */
function single<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (!row) throw new Error("expected exactly one row, got none");
  return row;
}

/** The real, Drizzle/Postgres-backed `ElevationRepo` — what production and this unit's E2E verification run against. */
export const ElevationRepoLive = Layer.effect(
  ElevationRepoTag,
  Effect.gen(function* () {
    const db = yield* Db;

    const findMachine: ElevationRepo["findMachine"] = (machineId) =>
      Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(machines)
            .where(eq(machines.id, machineId))
            .then((rows) => rows[0] ?? null),
        catch: toError,
      });

    const findPerson: ElevationRepo["findPerson"] = (personId) =>
      Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(people)
            .where(eq(people.id, personId))
            .then((rows) => rows[0] ?? null),
        catch: toError,
      });

    const findElevation: ElevationRepo["findElevation"] = (elevationId) =>
      Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(elevations)
            .where(eq(elevations.id, elevationId))
            .then((rows) => rows[0] ?? null),
        catch: toError,
      });

    const findSettingRows: ElevationRepo["findSettingRows"] = (keys, scopeIds) =>
      Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(settingValues)
            .where(
              and(
                inArray(settingValues.key, [...keys]),
                inArray(settingValues.scopeId, [...scopeIds]),
              ),
            ),
        catch: toError,
      }).pipe(
        Effect.map((rows) =>
          rows.map(
            (row): SettingRow<unknown> => ({
              scopeType: row.scopeType,
              scopeId: row.scopeId,
              key: row.key,
              value: row.value,
              source: row.source,
            }),
          ),
        ),
      );

    const insertElevation: ElevationRepo["insertElevation"] = (values) =>
      Effect.tryPromise({
        try: () => db.insert(elevations).values(values).returning().then(single),
        catch: toError,
      });

    const updateElevationGranted: ElevationRepo["updateElevationGranted"] = (
      elevationId,
      grantedAt,
      expiresAt,
    ) =>
      Effect.tryPromise({
        try: () =>
          db
            .update(elevations)
            .set({ status: "granted", grantedAt, expiresAt })
            .where(eq(elevations.id, elevationId))
            .returning()
            .then(single),
        catch: toError,
      });

    const updateElevationStatus: ElevationRepo["updateElevationStatus"] = (elevationId, status) =>
      Effect.tryPromise({
        try: () =>
          db
            .update(elevations)
            .set({ status })
            .where(eq(elevations.id, elevationId))
            .returning()
            .then(single),
        catch: toError,
      });

    return {
      findMachine,
      findPerson,
      findElevation,
      findSettingRows,
      insertElevation,
      updateElevationGranted,
      updateElevationStatus,
    } satisfies ElevationRepo;
  }),
);
