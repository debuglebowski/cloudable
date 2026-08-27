import { Context, Effect, Layer } from "effect";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@cloudable/schema";
import { config } from "../config";

/** The Drizzle database handle, scoped to the process's Postgres connection. */
export class Db extends Context.Tag("Db")<Db, PostgresJsDatabase<typeof schema>>() {}

/**
 * Opens the Postgres connection and wraps it with Drizzle. Scoped so the
 * connection is closed via `Effect.addFinalizer` when the layer's scope
 * (i.e. the whole application) shuts down.
 */
export const DbLive = Layer.scoped(
  Db,
  Effect.gen(function* () {
    const sql = postgres(config.databaseUrl);
    yield* Effect.addFinalizer(() => Effect.promise(() => sql.end()));
    return drizzle(sql, { schema });
  }),
);
