import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EVENTS_RETENTION_DAYS,
  EVENTS_RETENTION_DAYS_KEY,
  MIN_EVENTS_RETENTION_DAYS,
  effectiveEventsRetentionDays,
  isValidEventsRetentionDays,
} from "./policy";

describe("event retention policy", () => {
  test("defaults to 365 days with a fixed floor of 90, under its own key (not the snapshot window's)", () => {
    expect(DEFAULT_EVENTS_RETENTION_DAYS).toBe(365);
    expect(MIN_EVENTS_RETENTION_DAYS).toBe(90);
    expect(EVENTS_RETENTION_DAYS_KEY).toBe("events.retentionDays");
    expect(EVENTS_RETENTION_DAYS_KEY).not.toBe("archive.retentionDays");
  });

  test("a write is valid only as a whole number of days at or above the floor", () => {
    expect(isValidEventsRetentionDays(90)).toBe(true);
    expect(isValidEventsRetentionDays(365)).toBe(true);
    expect(isValidEventsRetentionDays(3650)).toBe(true);

    expect(isValidEventsRetentionDays(89)).toBe(false);
    expect(isValidEventsRetentionDays(0)).toBe(false);
    expect(isValidEventsRetentionDays(-1)).toBe(false);
    expect(isValidEventsRetentionDays(100.5)).toBe(false);
    expect(isValidEventsRetentionDays(Number.NaN)).toBe(false);
    expect(isValidEventsRetentionDays(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidEventsRetentionDays("365")).toBe(false);
    expect(isValidEventsRetentionDays(null)).toBe(false);
    expect(isValidEventsRetentionDays(undefined)).toBe(false);
  });

  test("the window the sweep applies is never below the floor, whatever is stored", () => {
    expect(effectiveEventsRetentionDays(365)).toBe(365);
    expect(effectiveEventsRetentionDays(90)).toBe(90);
    expect(effectiveEventsRetentionDays(1000)).toBe(1000);

    // A row that got past validation must not turn the sweep into a mass delete.
    expect(effectiveEventsRetentionDays(5)).toBe(90);
    expect(effectiveEventsRetentionDays(0)).toBe(90);
    expect(effectiveEventsRetentionDays(-400)).toBe(90);
    expect(effectiveEventsRetentionDays(120.9)).toBe(120);
  });

  test("a missing or unreadable stored value falls back to the default, not the floor", () => {
    expect(effectiveEventsRetentionDays(undefined)).toBe(365);
    expect(effectiveEventsRetentionDays(null)).toBe(365);
    expect(effectiveEventsRetentionDays("90")).toBe(365);
    expect(effectiveEventsRetentionDays({})).toBe(365);
    expect(effectiveEventsRetentionDays(Number.NaN)).toBe(365);
    expect(effectiveEventsRetentionDays(Number.POSITIVE_INFINITY)).toBe(365);
  });
});
