// ---------------------------------------------------------------------------
// Access method policy: access method is policy, inherited
// through the chain — contractors browser-only, employees browser plus
// certificates, exceptions visible as overrides. Stored as an ordinary
// `settingValues` row (org → machine chain — templates excluded, matching
// every other settings consumer in this codebase; templates are not in v1)
// rather than a dedicated table, same reasoning `logging/settings.ts`
// documents for logging tier/retention location: the resolution mechanism
// already exists and is the single source of truth for every other
// setting, so a parallel table would just be a second, divergence-prone
// place to look.
//
// Plain functions taking a `db` handle directly (not the `Db` context tag)
// — same convention `logging/settings.ts` uses, so `TunnelServer.mintSession`
// (which already has `db` in scope from its own `Db` yield) can call this
// without a second, redundant context requirement.
// ---------------------------------------------------------------------------
import { settingValues } from "@cloudable/schema";
import { type SettingRow, resolveSetting } from "@cloudable/schema";
import type * as schema from "@cloudable/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Data, Effect } from "effect";
import type { SessionMethod } from "./session-token";

type DbHandle = PostgresJsDatabase<typeof schema>;

export const ACCESS_METHODS_KEY = "access_methods";

/**
 * An org/machine that has never configured this setting behaves as if access were never
 * restricted at all — CLAUDE.md's "no wizard prefill of any kind" applies just as much to
 * defaults as to prefilled values: nothing should be silently disabled by omission.
 */
export const DEFAULT_ACCESS_METHODS: readonly SessionMethod[] = ["terminal", "ssh"];

export class AccessMethodSettingsError extends Data.TaggedError("AccessMethodSettingsError")<{
  reason: string;
  cause?: unknown;
}> {}

/**
 * Resolves which session methods are enabled for a machine, walking the org → machine
 * chain via `resolveSetting` (the exact same mechanism `resolveManifest`/logging settings
 * use — see `docs/inheritance.md`). Defaults to `DEFAULT_ACCESS_METHODS` when neither scope
 * has a row for this key.
 */
export const resolveEnabledAccessMethods = (
  db: DbHandle,
  chain: { orgId: string; machineId: string },
): Effect.Effect<readonly SessionMethod[], AccessMethodSettingsError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            scopeType: settingValues.scopeType,
            scopeId: settingValues.scopeId,
            value: settingValues.value,
            source: settingValues.source,
          })
          .from(settingValues)
          .where(
            and(
              eq(settingValues.key, ACCESS_METHODS_KEY),
              inArray(settingValues.scopeId, [chain.orgId, chain.machineId]),
            ),
          ),
      catch: (cause) => new AccessMethodSettingsError({ reason: "read_failed", cause }),
    });

    // `scopeId` alone can't disambiguate an org row from a machine row if the two ids ever
    // collided (they can't — different tables, different generators — but filtering by
    // `scopeType` too, not just relying on `inArray`'s id match, keeps this correct even if
    // that ever stopped being true) — so keep only rows whose (scopeType, scopeId) pair
    // actually matches this chain.
    const settingRows: ReadonlyArray<SettingRow<readonly SessionMethod[]>> = rows
      .filter(
        (row) =>
          (row.scopeType === "org" && row.scopeId === chain.orgId) ||
          (row.scopeType === "machine" && row.scopeId === chain.machineId),
      )
      .map((row) => ({
        scopeType: row.scopeType as "org" | "machine",
        scopeId: row.scopeId,
        key: ACCESS_METHODS_KEY,
        value: row.value as readonly SessionMethod[],
        source: row.source as "org" | "machine",
      }));

    const resolved = resolveSetting(ACCESS_METHODS_KEY, settingRows, {
      orgId: chain.orgId,
      machineId: chain.machineId,
    });
    return resolved?.value ?? DEFAULT_ACCESS_METHODS;
  });
