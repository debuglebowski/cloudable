import type { AccessMethodsEnabled } from "@cloudable/contracts";
import type * as schema from "@cloudable/schema";
import { type SettingRow, resolveSetting, settingValues } from "@cloudable/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Data, Effect } from "effect";

/**
 * Two more org → template → machine resolved settings from the
 * machine model's setting list (package manifest, persistent paths, access methods
 * enabled, logging tier, region, one owner) — alongside the package
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

/** Disposable — persistent paths survive; the OS does not. */
export type PersistentPaths = string[];
export const DEFAULT_PERSISTENT_PATHS: PersistentPaths = [];

/**
 * Re-exported from `@cloudable/contracts` rather than redeclared. This was a local copy of
 * the same interface, which meant the wire shape the console reads and the shape the policy
 * gate resolves could gain a field independently — and a method the control plane thinks is
 * enabled by default while the console never renders a toggle for it is a silent hole in
 * "admin-disablable at any level".
 */
export type { AccessMethodsEnabled } from "@cloudable/contracts";

/** Every method on by default — an org must deliberately disable one (admin-disablable at any level). */
export const DEFAULT_ACCESS_METHODS_ENABLED: AccessMethodsEnabled = {
  webTerminal: true,
  ssh: true,
  files: true,
  snapshotInspect: true,
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

/**
 * Merges the resolved row ONTO the default, per key, rather than returning it verbatim.
 *
 * This is the one setting that needs it, because it is the only one whose value is an
 * object with independently-added keys. `resolveWithDefault` falls back to the default only
 * when NO row exists at any level; when a row does exist it wins whole. So a value written
 * before `files` was added — `{"webTerminal":true,"ssh":true}` — resolved with
 * `files: undefined`, which is falsy, so `mintSession` denied every file session
 * `method_disabled` and the file interface was invisibly dead on every org that had ever
 * configured access methods at all.
 *
 * It failed closed, so it was never a hole. But "adding a key needs no migration" is only
 * true if something actually applies the default for a key the stored object predates, and
 * doing it here means every consumer gets it — the policy gate, `MachineService`'s detail
 * response, and the console toggles built from it — instead of each remembering to.
 *
 * `source`/`resolvedFromScopeId` still describe where the row came from, unchanged: the
 * lineage answer is about which scope set this setting, and filling a missing key from the
 * default does not move it.
 */
export const resolveAccessMethodsEnabled = (
  db: DbHandle,
  chain: MachineSettingChain,
): Effect.Effect<ResolvedMachineSetting<AccessMethodsEnabled>, MachineSettingsError> =>
  resolveWithDefault<Partial<AccessMethodsEnabled>>(
    db,
    ACCESS_METHODS_ENABLED_KEY,
    chain,
    DEFAULT_ACCESS_METHODS_ENABLED,
  ).pipe(
    Effect.map((resolved) => ({
      ...resolved,
      value: { ...DEFAULT_ACCESS_METHODS_ENABLED, ...(resolved.value ?? {}) },
    })),
  );

/** `value?.webTerminal ?? DEFAULT_ACCESS_METHODS_ENABLED.webTerminal` — shared by
 * `apply-setting-change.ts`'s termination side effect so both read the same fallback. */
export function webTerminalEnabledOf(value: unknown): boolean {
  const v = value as Partial<AccessMethodsEnabled> | null | undefined;
  return v?.webTerminal ?? DEFAULT_ACCESS_METHODS_ENABLED.webTerminal;
}

/** The `files` counterpart of `webTerminalEnabledOf`, same fallback rule. Separate from
 * the web terminal because the two are separately disablable — see `AccessMethodsEnabled`
 * in `packages/contracts` for why. A value stored before `files` existed has no such key
 * and resolves to the default, so nothing needs backfilling. */
export function filesEnabledOf(value: unknown): boolean {
  const v = value as Partial<AccessMethodsEnabled> | null | undefined;
  return v?.files ?? DEFAULT_ACCESS_METHODS_ENABLED.files;
}

/** The `snapshotInspect` counterpart, same fallback rule. */
export function snapshotInspectEnabledOf(value: unknown): boolean {
  const v = value as Partial<AccessMethodsEnabled> | null | undefined;
  return v?.snapshotInspect ?? DEFAULT_ACCESS_METHODS_ENABLED.snapshotInspect;
}
