export interface SettingRow<T = unknown> {
  scopeType: "org" | "profile" | "machine";
  scopeId: string;
  key: string;
  value: T;
  source: "org" | "profile" | "machine";
}
export interface ResolvedSetting<T = unknown> {
  key: string;
  value: T;
  source: SettingRow<T>["source"];
  resolvedFromScopeId: string;
}

/**
 * The chain one machine resolves through: org → base profile → profile → machine. A base
 * profile's rows are `scopeType: "profile"` like any profile's; `baseProfileId` says which
 * profile row sits above the machine's own profile. See docs/inheritance.md.
 */
export interface SettingChain {
  orgId: string;
  profileId?: string | null;
  /** The base the machine's profile extends, if any. Ignored without a `profileId`. */
  baseProfileId?: string | null;
  machineId: string;
}

/** The profile ids in a chain, nearest the machine first: the profile, then its base. */
export function chainProfileIds(chain: {
  profileId?: string | null;
  baseProfileId?: string | null;
}): string[] {
  if (!chain.profileId) return [];
  return chain.baseProfileId ? [chain.profileId, chain.baseProfileId] : [chain.profileId];
}

/** Lowest level wins: machine, then the profile, then its base, then the org. */
export function resolveSetting<T>(
  key: string,
  rows: ReadonlyArray<SettingRow<T>>,
  chain: SettingChain,
): ResolvedSetting<T> | undefined {
  const byScope = (scopeType: SettingRow["scopeType"], scopeId: string) =>
    rows.find((r) => r.key === key && r.scopeType === scopeType && r.scopeId === scopeId);
  const machine = byScope("machine", chain.machineId);
  if (machine)
    return {
      key,
      value: machine.value,
      source: machine.source,
      resolvedFromScopeId: chain.machineId,
    };
  for (const profileId of chainProfileIds(chain)) {
    const row = byScope("profile", profileId);
    if (row) return { key, value: row.value, source: row.source, resolvedFromScopeId: profileId };
  }
  const org = byScope("org", chain.orgId);
  return org
    ? { key, value: org.value, source: org.source, resolvedFromScopeId: chain.orgId }
    : undefined;
}
