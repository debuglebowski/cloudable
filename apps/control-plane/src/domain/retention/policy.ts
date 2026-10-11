import {
  EVENTS_RETENTION_DEFAULT_DAYS,
  EVENTS_RETENTION_MIN_DAYS,
  EVENTS_RETENTION_SETTING_KEY,
} from "@cloudable/contracts";

/**
 * Event retention policy: how long an org keeps its events.
 *
 * Separate from `archive.retentionDays` (`domain/archive/org-policy.ts`), which is how
 * long a snapshot's volume data lives. The two answer different questions and an org
 * may reasonably want a short snapshot window with a long audit trail, so they are
 * different settings.
 *
 * Org scope only. Events are an org-wide stream and nothing resolves a window per
 * machine, so there is no machine-level chain to read.
 *
 * Pure on purpose, with no database or Effect dependencies: `applySettingChange`
 * validates writes against it and the sweep reads through it, and neither should have to
 * import the other's machinery.
 */

export const EVENTS_RETENTION_DAYS_KEY = EVENTS_RETENTION_SETTING_KEY;
export const DEFAULT_EVENTS_RETENTION_DAYS = EVENTS_RETENTION_DEFAULT_DAYS;
export const MIN_EVENTS_RETENTION_DAYS = EVENTS_RETENTION_MIN_DAYS;

/** The `OrgSettingsError` reason for a rejected write. Carries the floor so a client
 * showing it verbatim says what the limit is. */
export const EVENTS_RETENTION_INVALID_REASON = `event_retention_days_must_be_an_integer_of_at_least_${MIN_EVENTS_RETENTION_DAYS}`;

/** A value an admin may save: a whole number of days, no lower than the floor. */
export const isValidEventsRetentionDays = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= MIN_EVENTS_RETENTION_DAYS;

/**
 * The window the sweep actually applies for whatever is stored.
 *
 * Writes are validated, so a stored value is normally fine. This is the second line of
 * defence for a row that got in some other way (a hand-edited database, an import from
 * before the floor existed): the sweep deletes data, so it never trusts a stored number
 * to be sane. Below the floor it uses the floor; unreadable or missing, the default.
 */
export const effectiveEventsRetentionDays = (stored: unknown): number => {
  if (typeof stored !== "number" || !Number.isFinite(stored)) {
    return DEFAULT_EVENTS_RETENTION_DAYS;
  }
  return Math.max(MIN_EVENTS_RETENTION_DAYS, Math.floor(stored));
};
