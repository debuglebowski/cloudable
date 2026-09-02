import * as schema from "@cloudable/schema";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { e2eConfig } from "./config";

/**
 * A direct DB connection, same pattern as
 * `apps/control-plane/scripts/seed-demo.ts` — e2e setup/teardown insert and
 * delete an `orgs`/`people` row directly rather than through the HTTP API
 * because there is no API surface for either (see that script's own doc
 * comment on why `orgs`/`people` are the one exception to "always go
 * through the real API").
 */
export function connect() {
  const client = postgres(e2eConfig.databaseUrl);
  return { client, db: drizzle(client, { schema }) };
}

export { schema };
