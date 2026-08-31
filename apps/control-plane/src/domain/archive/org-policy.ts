import { type SettingRow, resolveSetting, settingValues } from "@cloudable/schema";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import { dbTry } from "./queries";

/**
 * Org-configurable archive policy, resolved through `resolveSetting()` (org → machine —
 * there is no template layer in v1, and no per-machine override is written by any
 * feature unit yet, but the chain supports one for free the day it's needed).
 *
 * Restore-approval policy is NOT resolved here — despite once having its own dead
 * `archive.restoreApprovalMode` key (removed; it was read but never written anywhere,
 * and its own default disagreed with the setting that actually gates restores). The
 * real gate is `ApprovalService`'s own `approval_mode:snapshot_restore` setting,
 * resolved inside `ApprovalService.request()` and escalated per restore mode via
 * `approval-escalation.ts`'s `resolveRestoreApprovalFloor` — see `restore.ts`.
 */

export const RETENTION_DAYS_KEY = "archive.retentionDays";
export const DEFAULT_RETENTION_DAYS = 30;

const loadSettingRows = <T>(
  orgId: string,
  machineId: string,
  key: string,
): Effect.Effect<SettingRow<T>[], never, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    // Best-effort: a transient failure reading policy settings falls back to the
    // documented defaults below rather than blocking the whole archive/restore
    // operation on a settings-lookup hiccup.
    const raw = yield* dbTry(
      () =>
        db
          .select()
          .from(settingValues)
          .where(
            and(eq(settingValues.key, key), inArray(settingValues.scopeId, [orgId, machineId])),
          ),
      "load_setting_rows",
    ).pipe(Effect.orElseSucceed(() => [] as (typeof settingValues.$inferSelect)[]));

    return raw.map(
      (r): SettingRow<T> => ({
        scopeType: r.scopeType,
        scopeId: r.scopeId,
        key: r.key,
        value: r.value as T,
        source: r.source,
      }),
    );
  });

export const resolveRetentionDays = (
  orgId: string,
  machineId: string,
): Effect.Effect<number, never, Db> =>
  Effect.gen(function* () {
    const rows = yield* loadSettingRows<number>(orgId, machineId, RETENTION_DAYS_KEY);
    const resolved = resolveSetting<number>(RETENTION_DAYS_KEY, rows, { orgId, machineId });
    return resolved?.value ?? DEFAULT_RETENTION_DAYS;
  });
