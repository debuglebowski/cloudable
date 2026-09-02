// Config editor + GitOps path. Plain, dependency-free
// wire types shared directly from source by the CLI (no generation step).
// The control plane's HTTP layer
// (`apps/control-plane/src/http/routes/config.ts`) defines its own
// `effect/Schema` structs with the same shape for runtime validation; these
// interfaces are the type-only mirror used by non-Effect consumers.

/** v1 only supports editing at org or machine scope — template scope has no UI yet. */
export type SettingScopeType = "org" | "machine";

/**
 * The generic settings key for logging tier — the one literal
 * key string a non-Effect consumer needs to know to write a
 * `PatchSettingRequest`/`ImportConfigEntry` targeting it. Defined here
 * (rather than only in `apps/control-plane/src/logging/settings.ts`,
 * which re-exports it as `LOGGING_TIER_KEY` for its own internal callers)
 * so the console has one shared constant to import instead of a second,
 * independently-typed copy of the same string literal.
 */
export const LOGGING_TIER_SETTING_KEY = "logging_tier";

// `orgId`/`actor` are gone from every request below: the server derives
// both from the caller's session (`CurrentUserTag`) — every config change
// is now necessarily a real person acting through the console, not a
// client-supplied identity.

export interface PatchSettingRequest {
  scopeType: SettingScopeType;
  scopeId: string;
  key: string;
  value: unknown;
  /** Org-scope only: marks the entry un-overridable below. */
  pinned?: boolean;
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

/** Bulk desired-state document — the GitOps path. Applied entry-by-entry through the exact same code path as `PatchSettingRequest` — same path whether the change came from the UI or a Git commit. */
export interface ImportConfigRequest {
  /** Shared across every event this import produces. Generated if omitted. */
  correlationId?: string;
  entries: ImportConfigEntry[];
}

export interface ImportConfigResponse {
  applied: SettingChangeResult[];
}
