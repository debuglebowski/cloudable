import { NIXPKGS_COMMIT_PATTERN } from "@cloudable/contracts";
import { settingValues } from "@cloudable/schema";
import type * as schema from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";

/**
 * The nixpkgs commit an org's `nix:` packages install from
 * (`packages.nix.snapshot`). An org setting, changed on the Organisation page
 * and recorded as `org.setting_changed` like any other.
 *
 * Nix has no per-package version the way apt or npm do. A commit of nixpkgs
 * fixes the version of every package in it, so one commit for the whole org
 * means every machine gets the same versions, and updating them is an admin
 * moving this commit forward. A single package can still pin its own commit
 * (its version pin), which wins over this.
 *
 * Unset means no `nix:` package can be installed: the agent refuses an install
 * with no commit rather than take whatever nixpkgs is newest that day.
 */
export const NIX_SNAPSHOT_KEY = "packages.nix.snapshot";

export const NIX_SNAPSHOT_INVALID_REASON = "nix_snapshot_must_be_a_nixpkgs_commit";

/** A full 40-character nixpkgs commit, or null to clear it. */
export const isValidNixSnapshot = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && NIXPKGS_COMMIT_PATTERN.test(value));

/** A stored value that is not a commit reads as unset, never as something to install from. */
export const effectiveNixSnapshot = (stored: unknown): string | null =>
  typeof stored === "string" && NIXPKGS_COMMIT_PATTERN.test(stored) ? stored : null;

/** Reads the org's snapshot. A failed read is unset: no Nix install goes ahead on a guess. */
export const readNixSnapshot = (
  db: PostgresJsDatabase<typeof schema>,
  orgId: string,
): Effect.Effect<string | null> =>
  Effect.tryPromise(() =>
    db
      .select({ value: settingValues.value })
      .from(settingValues)
      .where(
        and(
          eq(settingValues.scopeType, "org"),
          eq(settingValues.scopeId, orgId),
          eq(settingValues.key, NIX_SNAPSHOT_KEY),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.map((rows) => effectiveNixSnapshot(rows[0]?.value)),
    Effect.orElseSucceed(() => null),
  );

/**
 * The nixpkgs commit one action installs from: the package's own pin when it is a
 * commit, else the org's snapshot. Undefined for any other manager, and when
 * neither is set.
 */
export const nixpkgsCommitFor = (
  packageName: string,
  versionPin: string | null,
  orgSnapshot: string | null,
): string | undefined => {
  if (!packageName.startsWith("nix:")) return undefined;
  if (versionPin && NIXPKGS_COMMIT_PATTERN.test(versionPin)) return versionPin;
  return orgSnapshot ?? undefined;
};
