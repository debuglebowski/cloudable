import { settingValues } from "@cloudable/schema";
import type * as schema from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";

/**
 * How long Cloudable waits before it tries an *Ensure* install again after one
 * failed or expired. An org setting (`packages.ensureRetryHours`), changed on
 * the Organisation page and recorded as `org.setting_changed` like any other.
 *
 * Without a wait, a package that cannot install (a name the repository does
 * not have, a broken mirror) would be retried on every report, every thirty
 * seconds, and each try is a recorded action.
 */
export const ENSURE_RETRY_HOURS_KEY = "packages.ensureRetryHours";

export const DEFAULT_ENSURE_RETRY_HOURS = 24;

/** One hour to thirty days. */
export const isValidEnsureRetryHours = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 720;

export const ENSURE_RETRY_HOURS_INVALID_REASON = "ensure_retry_hours_must_be_1_to_720";

/** A stored value that is not valid reads as the default rather than as no wait at all. */
export const effectiveEnsureRetryHours = (stored: unknown): number =>
  isValidEnsureRetryHours(stored) ? stored : DEFAULT_ENSURE_RETRY_HOURS;

/** Reads the org's retry wait, in hours, falling back to the default. */
export const readEnsureRetryHours = (
  db: PostgresJsDatabase<typeof schema>,
  orgId: string,
): Effect.Effect<number> =>
  Effect.tryPromise(() =>
    db
      .select({ value: settingValues.value })
      .from(settingValues)
      .where(
        and(
          eq(settingValues.scopeType, "org"),
          eq(settingValues.scopeId, orgId),
          eq(settingValues.key, ENSURE_RETRY_HOURS_KEY),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.map((rows) => effectiveEnsureRetryHours(rows[0]?.value)),
    // A failed read must not stop ensure from working, and the default is the safe side.
    Effect.orElseSucceed(() => DEFAULT_ENSURE_RETRY_HOURS),
  );
