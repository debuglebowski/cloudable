// Config editor + GitOps path (docs/spec.md §16). Plain, dependency-free
// wire types shared directly from source by the CLI (no generation step —
// see docs/spec.md §25). The control plane's HTTP layer
// (`apps/control-plane/src/http/routes/config.ts`) defines its own
// `effect/Schema` structs with the same shape for runtime validation; these
// interfaces are the type-only mirror used by non-Effect consumers.

/** v1 only supports editing at org or machine scope — template scope has no UI yet. */
export type SettingScopeType = "org" | "machine";

/**
 * The generic settings key for logging tier (spec §17) — the one literal
 * key string a non-Effect consumer needs to know to write a
 * `PatchSettingRequest`/`ImportConfigEntry` targeting it. Defined here
 * (rather than only in `apps/control-plane/src/logging/settings.ts`,
 * which re-exports it as `LOGGING_TIER_KEY` for its own internal callers)
 * so the console has one shared constant to import instead of a second,
 * independently-typed copy of the same string literal.
 */
export const LOGGING_TIER_SETTING_KEY = "logging_tier";

/**
 * Who made the change. "person" is a UI-driven admin edit; "system" is a
 * Git-sourced (or otherwise automated) change applied via `/config/import`.
 * Once real auth (`CurrentUserTag`) is wired to the PATCH endpoint, this can
 * become derived-and-optional instead of caller-supplied.
 */
export interface ConfigActor {
  type: "person" | "system";
  id: string;
}

export interface PatchSettingRequest {
  orgId: string;
  scopeType: SettingScopeType;
  scopeId: string;
  key: string;
  value: unknown;
  /** Org-scope only: marks the entry un-overridable below (docs/spec.md §6). */
  pinned?: boolean;
  actor: ConfigActor;
}

export interface SettingChangeResult {
  scopeType: SettingScopeType;
  scopeId: string;
  key: string;
  previous: unknown;
  current: unknown;
}

export interface PatchSettingResponse {
  setting: SettingChangeResult;
}

/** `confirm` must be exactly `true` — absent or `false` is rejected (400). */
export interface ReconcileTriggerRequest {
  /** Must match the target machine's org — the tenant-isolation check (no `CurrentUserTag` session exists yet to derive this from). */
  orgId: string;
  confirm?: boolean;
}

export interface ReconcileTriggerResponse {
  machineId: string;
  desiredStateVersion: number;
}

export interface ImportConfigEntry {
  scopeType: SettingScopeType;
  scopeId: string;
  key: string;
  value: unknown;
  pinned?: boolean;
}

/** Bulk desired-state document — the GitOps path. Applied entry-by-entry through the exact same code path as `PatchSettingRequest` (docs/spec.md §16: "same path whether the change came from the UI or a Git commit"). */
export interface ImportConfigRequest {
  orgId: string;
  actor: ConfigActor;
  /** Shared across every event this import produces. Generated if omitted. */
  correlationId?: string;
  entries: ImportConfigEntry[];
}

export interface ImportConfigResponse {
  applied: SettingChangeResult[];
}
