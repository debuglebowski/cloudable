/** A bare name is apt; anything with a `manager:` prefix is not. */
const isAptName = (packageName: string): boolean => !packageName.includes(":");

/**
 * Whether an installed version satisfies a manifest pin, for an apt package.
 *
 * apt's own rule for `apt-get install name=pin`: an exact version, or a pattern
 * with `*` (any run of characters) or `?` (one character), matched against the whole
 * version string. `24.*` matches `24.22.3-1nodesource1`; `24` matches only `24`.
 *
 * Null for anything this cannot judge: no pin, or a package manager other than apt
 * (npm, pipx and cargo pins are ranges in their own syntax; a Nix pin is a commit).
 * Callers treat null as "no evidence of a mismatch".
 */
export function aptVersionMatchesPin(
  packageName: string,
  installedVersion: string | null | undefined,
  versionPin: string | null | undefined,
): boolean | null {
  if (!versionPin || installedVersion == null || !isAptName(packageName)) return null;
  if (!/[*?]/.test(versionPin)) return installedVersion === versionPin;
  const pattern = versionPin
    .split("")
    .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${pattern}$`).test(installedVersion);
}
