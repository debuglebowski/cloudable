import { type AccessMethodsEnabled, LOGGING_TIER_SETTING_KEY } from "@cloudable/contracts";

/**
 * The settings a profile may set. Matches `PROFILE_SETTING_KEYS` in the control plane
 * (`domain/profile/setting-keys.ts`). Everything else is org-wide.
 */
export type ProfileSettingKey =
  | typeof LOGGING_TIER_SETTING_KEY
  | "machine.accessMethodsEnabled"
  | "admin_access_elevation_ttl_minutes";

export interface ProfileSettingSpec {
  key: ProfileSettingKey;
  label: string;
  /** One plain sentence on what it does to the profile's machines. */
  help: string;
}

export const PROFILE_SETTINGS: ProfileSettingSpec[] = [
  {
    key: LOGGING_TIER_SETTING_KEY,
    label: "Logging tier",
    help: "Tier 1 records metadata only. Tier 2 also records sessions and config changes.",
  },
  {
    key: "machine.accessMethodsEnabled",
    label: "Access methods",
    help: "Which ways in are turned on. Turning one off ends its open sessions.",
  },
  {
    key: "admin_access_elevation_ttl_minutes",
    label: "Elevation length",
    help: "How many minutes an admin's elevated access to a machine lasts.",
  },
];

const ACCESS_METHOD_LABELS: Record<keyof AccessMethodsEnabled, string> = {
  webTerminal: "web terminal",
  ssh: "SSH",
  files: "files",
  snapshotInspect: "snapshot browsing",
};

export const ACCESS_METHOD_KEYS = Object.keys(ACCESS_METHOD_LABELS) as Array<
  keyof AccessMethodsEnabled
>;

export const accessMethodLabel = (key: keyof AccessMethodsEnabled) => ACCESS_METHOD_LABELS[key];

/** A stored value in words. */
export function describeSettingValue(key: ProfileSettingKey, value: unknown): string {
  switch (key) {
    case LOGGING_TIER_SETTING_KEY:
      return value === 2 ? "Tier 2" : value === 1 ? "Tier 1" : String(value);
    case "machine.accessMethodsEnabled": {
      const methods = (value ?? {}) as Partial<AccessMethodsEnabled>;
      const on = ACCESS_METHOD_KEYS.filter((k) => methods[k] !== false).map(accessMethodLabel);
      return on.length > 0 ? `On: ${on.join(", ")}` : "All off";
    }
    case "admin_access_elevation_ttl_minutes":
      return `${String(value)} minutes`;
  }
}
