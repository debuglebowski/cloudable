import { LOGGING_TIER_KEY } from "../../logging/settings";
import { ADMIN_ACCESS_ELEVATION_TTL_MINUTES_SETTING_KEY } from "../elevation/policy";
import { ACCESS_METHODS_ENABLED_KEY } from "../machine/settings";

/**
 * The settings a profile may set. Each is read per machine through the
 * org → profile → machine chain, so a profile value reaches its machines.
 *
 * Everything else is org-wide and refused at profile scope: event retention,
 * approval modes, vulnerability scanning, the Nix snapshot, the Ensure retry
 * wait, malware protection, and the deploy-time admin access policy. `machine.persistentPaths`
 * is left out too: it is resolved, but nothing acts on it yet, so a profile value would do
 * nothing. Packages
 * are not here either: they live in `machine_packages` and have their own path
 * (`updateProfilePackages`). See `docs/inheritance.md`.
 */
export const PROFILE_SETTING_KEYS: ReadonlySet<string> = new Set([
  LOGGING_TIER_KEY,
  ACCESS_METHODS_ENABLED_KEY,
  ADMIN_ACCESS_ELEVATION_TTL_MINUTES_SETTING_KEY,
]);

export const isProfileSettingKey = (key: string): boolean => PROFILE_SETTING_KEYS.has(key);
