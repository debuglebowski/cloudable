import { people } from "@cloudable/schema";
import { HttpApiBuilder } from "@effect/platform";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import { Api } from "../api";

export const PeopleLive = HttpApiBuilder.group(Api, "people", (handlers) =>
  handlers.handle("list", ({ urlParams }) =>
    Effect.gen(function* () {
      const db = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: people.id, email: people.email, role: people.role, active: people.active })
            .from(people)
            .where(eq(people.orgId, urlParams.orgId))
            .orderBy(asc(people.email)),
        catch: () => new Error("people_query_failed"),
      }).pipe(Effect.orDie);
      return { items: rows };
    }),
  ),
);
