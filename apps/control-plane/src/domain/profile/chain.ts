// ---------------------------------------------------------------------------
// The profile part of a machine's chain: org → base profile → profile → machine.
//
// A machine row carries only its `profileId`. Every place that resolves a setting, a package
// or a creation field for a machine needs the base too, so it reads it here. Resolvers that
// take a chain fill the base in themselves when the caller left it out (`withBaseProfile`), so
// no caller can forget it. See docs/inheritance.md.
// ---------------------------------------------------------------------------
import { profiles } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import type { Context } from "effect";
import type { Db } from "../../db/layer";

type DbHandle = Context.Tag.Service<typeof Db>;

/** The base `profileId` extends, or null. Null for no profile. */
export const baseProfileIdOf = async (
  db: DbHandle,
  profileId: string | null | undefined,
): Promise<string | null> => {
  if (!profileId) return null;
  const rows = await db
    .select({ baseProfileId: profiles.baseProfileId })
    .from(profiles)
    .where(eq(profiles.id, profileId))
    .limit(1);
  return rows[0]?.baseProfileId ?? null;
};

/**
 * The same chain with `baseProfileId` filled in. A chain that already says (even null) is
 * returned as it is, so a caller that read the base already pays for no second query.
 */
export const withBaseProfile = async <
  C extends { profileId?: string | null; baseProfileId?: string | null },
>(
  db: DbHandle,
  chain: C,
): Promise<C & { baseProfileId: string | null }> => {
  if (chain.baseProfileId !== undefined) {
    return { ...chain, baseProfileId: chain.baseProfileId };
  }
  return { ...chain, baseProfileId: await baseProfileIdOf(db, chain.profileId) };
};
