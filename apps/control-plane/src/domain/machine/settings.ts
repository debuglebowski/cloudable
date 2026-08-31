import type * as schema from "@cloudable/schema";
import { type SettingRow, resolveSetting, settingValues } from "@cloudable/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Data, Effect } from "effect";

/**
 * Two more org → template → machine resolved settings from spec.md §7's
 * machine model list ("package manifest, persistent paths, access methods
 * enabled, logging tier, region, one owner") — alongside the package
 * manifest (`manifest.ts`). Both follow the exact `resolveSetting()`
 * pattern `domain/archive/org-policy.ts` uses for retention/approval-mode:
 * raw rows live in the generic `settingValues` table (no dedicated table,
 * no migration needed — see docs/inheritance.md), keyed by the string
 * constants below. Unlike logging tier (`logging/settings.ts`), which is
 * deliberately collapsed to org scope only for now, these two are resolved
 * through the real chain (org → machine in v1; template is inert but the
 * resolution call already supports it for free) — a machine can genuinely
 * override either one.
 *
 * Takes a `db` handle directly (`logging/settings.ts`'s style) rather than
 * yielding `Db` from Effect context (`domain/archive/org-policy.ts`'s
 * style): `MachineService` closes over its own `db` once at construction
 * (same as every other method on that service) and calls straight into
 * these, so requiring `Db` from context here would leak into
 * `MachineService.getById`'s own effect type for no benefit — nothing
 * else needs these resolvers run standalone against ambient context.
 */

type DbHandle = PostgresJsDatabase<typeof schema>;

export const PERSISTENT_PATHS_KEY = "machine.persistentPaths";
export const ACCESS_METHODS_ENABLED_KEY = "machine.accessMethodsEnabled";

/** spec.md §7: "disposable — persistent paths survive; the OS does not." */
export type PersistentPaths = string[];
export const DEFAULT_PERSISTENT_PATHS: PersistentPaths = [];

/** spec.md §7/§11: which of the two access methods are turned on for a machine. */
export interface AccessMethodsEnabled {
  webTerminal: boolean;
  ssh: boolean;
}

/** Both methods on by default — an org must deliberately disable one (spec §11: "Admin-disablable at any level"). */
export const DEFAULT_ACCESS_METHODS_ENABLED: AccessMethodsEnabled = {
  webTerminal: true,
  ssh: true,
};

export interface ResolvedMachineSetting<T> {
  value: T;
  source: "org" | "template" | "machine";
  resolvedFromScopeId: string;
}

export interface MachineSettingChain {
  orgId: string;
  templateId?: string | null;
  machineId: string;
}

export class MachineSettingsError extends Data.TaggedError("MachineSettingsError")<{
  reason: string;
  cause?: unknown;
}> {}

const loadChainRows = <T>(
  db: DbHandle,
  key: string,
  chain: MachineSettingChain,
): Effect.Effect<SettingRow<T>[], MachineSettingsError> =>
  Effect.gen(function* () {
    const scopeIds = [
      chain.orgId,
      chain.machineId,
      ...(chain.templateId ? [chain.templateId] : []),
    ];
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(settingValues)
          .where(and(eq(settingValues.key, key), inArray(settingValues.scopeId, scopeIds))),
      catch: (cause) => new MachineSettingsError({ reason: "read_failed", cause }),
    });
    return rows.map(
      (r): SettingRow<T> => ({
        scopeType: r.scopeType,
        scopeId: r.scopeId,
        key: r.key,
        value: r.value as T,
        source: r.source,
      }),
    );
  });

/** No row at any level: falls back to `defaultValue`, attributed to `org` (the top of
 * the chain) — consistent with "a machine created from org defaults" (docs/inheritance.md). */
const resolveWithDefault = <T>(
  db: DbHandle,
  key: string,
  chain: MachineSettingChain,
  defaultValue: T,
): Effect.Effect<ResolvedMachineSetting<T>, MachineSettingsError> =>
  Effect.gen(function* () {
    const rows = yield* loadChainRows<T>(db, key, chain);
    const resolved = resolveSetting<T>(key, rows, chain);
    return resolved
      ? {
          value: resolved.value,
          source: resolved.source,
          resolvedFromScopeId: resolved.resolvedFromScopeId,
        }
      : { value: defaultValue, source: "org", resolvedFromScopeId: chain.orgId };
  });

export const resolvePersistentPaths = (
  db: DbHandle,
  chain: MachineSettingChain,
): Effect.Effect<ResolvedMachineSetting<PersistentPaths>, MachineSettingsError> =>
  resolveWithDefault(db, PERSISTENT_PATHS_KEY, chain, DEFAULT_PERSISTENT_PATHS);

export const resolveAccessMethodsEnabled = (
  db: DbHandle,
  chain: MachineSettingChain,
): Effect.Effect<ResolvedMachineSetting<AccessMethodsEnabled>, MachineSettingsError> =>
  resolveWithDefault(db, ACCESS_METHODS_ENABLED_KEY, chain, DEFAULT_ACCESS_METHODS_ENABLED);

/** `value?.webTerminal ?? DEFAULT_ACCESS_METHODS_ENABLED.webTerminal` — shared by
 * `apply-setting-change.ts`'s termination side effect so both read the same fallback. */
export function webTerminalEnabledOf(value: unknown): boolean {
  const v = value as Partial<AccessMethodsEnabled> | null | undefined;
  return v?.webTerminal ?? DEFAULT_ACCESS_METHODS_ENABLED.webTerminal;
}
