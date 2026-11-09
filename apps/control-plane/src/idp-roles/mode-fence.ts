import { idpRoleMode } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { type AnyPgDb, MODE_ROW_ID } from "./activation";
import type { IdpRolesConfig } from "./config";

export type ModeFence = "ok" | "mismatch";

/**
 * Whether this process's roles-from-the-IdP config matches the persisted mode, read fresh. Every
 * way in asks it, on every request, because replicas are not restarted together: during a
 * rollout one replica may already run with the mode on (and have applied the activation) while
 * another still runs with it off or with an older mapping. A replica whose config disagrees with
 * the persisted mode serves no authenticated request at all, rather than serve it under rules no
 * longer in force:
 *
 * | This process | Persisted       | Result   |
 * | :--          | :--             | :--      |
 * | off          | off (or no row) | ok: today's behaviour, unchanged |
 * | off          | on              | mismatch |
 * | on           | on, same config | ok       |
 * | on           | on, other config| mismatch |
 * | on           | off (or no row) | mismatch (activation not applied, or another replica switched it off) |
 *
 * "Same config" is the fingerprint: claim, mapping, interval and the identity provider's trust
 * anchors (`config.ts`). A read failure is a mismatch in managed mode. With the mode off it is
 * ignored, so a database error here never changes behaviour for deployments not using the mode.
 */
export const checkModeFence = async (
  db: AnyPgDb,
  idpRoles: IdpRolesConfig | null,
): Promise<ModeFence> => {
  let row: { enabled: boolean; configFingerprint: string | null } | undefined;
  try {
    [row] = await db
      .select({ enabled: idpRoleMode.enabled, configFingerprint: idpRoleMode.configFingerprint })
      .from(idpRoleMode)
      .where(eq(idpRoleMode.id, MODE_ROW_ID))
      .limit(1);
  } catch {
    return idpRoles === null ? "ok" : "mismatch";
  }
  const persistedOn = row?.enabled === true;
  if (idpRoles === null) return persistedOn ? "mismatch" : "ok";
  return persistedOn && row?.configFingerprint === idpRoles.fingerprint ? "ok" : "mismatch";
};
