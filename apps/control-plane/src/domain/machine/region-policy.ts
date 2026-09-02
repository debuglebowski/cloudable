import type * as schema from "@cloudable/schema";
import { type SettingRow, resolveSetting, settingValues } from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";

type DbHandle = PostgresJsDatabase<typeof schema>;

/**
 * Org-configurable default region for new machines — region is
 * among every setting that must flow org → machine through
 * `resolveSetting()`, the same mechanism `domain/archive/org-policy.ts`
 * uses for retention days, rather than a client-side prefill that copies a
 * value and forgets its origin (no wizard prefill).
 *
 * Unlike retention (re-resolved on every read), region only ever gets
 * resolved once: at `MachineService.create` time. A live machine's region
 * is a physical fact about a provisioned Azure resource, not a policy that
 * can change underneath it — live machines
 * aren't edited — so there's no "machine-scoped region override" to
 * resolve against later, only the org default at the moment of creation.
 */
export const DEFAULT_REGION_KEY = "machine.defaultRegion";
export const DEFAULT_REGION = "eastus";

export interface ResolvedRegion {
  value: string;
  /** "org" when the org has explicitly configured a default; "default" when
   * falling back to `DEFAULT_REGION` because it hasn't. */
  source: "org" | "default";
}

const loadOrgRegionRows = (
  db: DbHandle,
  orgId: string,
): Effect.Effect<SettingRow<string>[], never> =>
  Effect.tryPromise({
    try: () =>
      db
        .select()
        .from(settingValues)
        .where(
          and(
            eq(settingValues.scopeType, "org"),
            eq(settingValues.scopeId, orgId),
            eq(settingValues.key, DEFAULT_REGION_KEY),
          ),
        )
        // Same convention as `readOrgScopedSetting`'s sibling read
        // (`domain/organisation/settings.ts`) — at most one org-scoped row
        // for this key is ever meant to exist (writes go through a
        // delete-then-insert transaction), so this caps the read at the
        // same invariant rather than silently tolerating more.
        .limit(1),
    // Best-effort, same convention as `org-policy.ts`'s `loadSettingRows`: a
    // transient read failure falls back to `DEFAULT_REGION` rather than
    // blocking machine creation on a settings-lookup hiccup. The specific
    // error value here is discarded unconditionally by `orElseSucceed`
    // below — passing `cause` through (rather than a fabricated fallback
    // value shaped like the success type) just keeps that discarded value
    // honest about what actually happened.
    catch: (cause) => cause,
  }).pipe(
    Effect.orElseSucceed(() => [] as (typeof settingValues.$inferSelect)[]),
    Effect.map((raw) =>
      raw.map(
        (r): SettingRow<string> => ({
          scopeType: r.scopeType,
          scopeId: r.scopeId,
          key: r.key,
          value: r.value as string,
          source: r.source,
        }),
      ),
    ),
  );

/**
 * Resolves the org's default region for a brand-new machine. `machineId` in
 * the chain is a placeholder that can never match a real row — the machine
 * doesn't exist yet — kept only so this reuses `resolveSetting()`'s chain
 * walk (docs/inheritance.md) instead of a parallel org-only lookup.
 */
export const resolveOrgDefaultRegion = (
  db: DbHandle,
  orgId: string,
): Effect.Effect<ResolvedRegion, never> =>
  Effect.gen(function* () {
    const rows = yield* loadOrgRegionRows(db, orgId);
    const resolved = resolveSetting<string>(DEFAULT_REGION_KEY, rows, {
      orgId,
      machineId: "pending-machine-creation",
    });
    return resolved
      ? { value: resolved.value, source: "org" as const }
      : { value: DEFAULT_REGION, source: "default" as const };
  });
