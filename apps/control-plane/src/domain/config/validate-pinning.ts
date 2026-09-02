/**
 * Pin validation for the package manifest.
 *
 * STUB: unit 2 (package manifest / inheritance) owns the real manifest
 * schema (a list of `{ package, version? }` entries) and its own
 * per-entry pin-validation function. That unit hasn't merged in this
 * build, so this is a basic placeholder: it treats the whole `packages`
 * setting key as one pinnable unit rather than pinning individual package
 * entries within it. Replace `isPackageManifestKey` and the pin check in
 * `apply-setting-change.ts` with a call into unit 2's real validator once
 * it exists — the settingValues.pinned column and the validation call site
 * are already in the right place for that swap.
 */
export const PACKAGE_MANIFEST_SETTING_KEY = "packages";

export function isPackageManifestKey(key: string): boolean {
  return key === PACKAGE_MANIFEST_SETTING_KEY;
}
