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

export function resolveSetting<T>(
  key: string,
  rows: ReadonlyArray<SettingRow<T>>,
  chain: { orgId: string; profileId?: string | null; machineId: string },
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
  if (chain.profileId) {
    const tpl = byScope("profile", chain.profileId);
    if (tpl)
      return { key, value: tpl.value, source: tpl.source, resolvedFromScopeId: chain.profileId };
  }
  const org = byScope("org", chain.orgId);
  return org
    ? { key, value: org.value, source: org.source, resolvedFromScopeId: chain.orgId }
    : undefined;
}
