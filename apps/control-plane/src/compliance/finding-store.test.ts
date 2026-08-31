import { describe, expect, test } from "bun:test";
import { ageInDays, medianAgeInDays } from "./finding-store";

const NOW = new Date("2026-01-10T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

describe("ageInDays", () => {
  test("whole days between firstSeen and now", () => {
    expect(ageInDays(daysAgo(14), NOW)).toBe(14);
  });

  test("floors partial days", () => {
    expect(ageInDays(new Date(NOW.getTime() - 36 * 60 * 60 * 1000), NOW)).toBe(1);
  });

  test("floors at 0 rather than going negative (firstSeen after now)", () => {
    expect(ageInDays(new Date(NOW.getTime() + 60_000), NOW)).toBe(0);
  });
});

describe("medianAgeInDays", () => {
  test("null for an empty set — no age distribution to summarize", () => {
    expect(medianAgeInDays([], NOW)).toBeNull();
  });

  test("the single age for a set of one", () => {
    expect(medianAgeInDays([daysAgo(5)], NOW)).toBe(5);
  });

  test("the middle value for an odd-sized set, order-independent", () => {
    const firstSeenAts = [daysAgo(9), daysAgo(1), daysAgo(3)];
    expect(medianAgeInDays(firstSeenAts, NOW)).toBe(3);
  });

  test("the average of the two middle values for an even-sized set", () => {
    const firstSeenAts = [daysAgo(9), daysAgo(5)];
    expect(medianAgeInDays(firstSeenAts, NOW)).toBe(7);
  });

  test("an even-sized set can median to a half-day", () => {
    const firstSeenAts = [daysAgo(5), daysAgo(2)];
    expect(medianAgeInDays(firstSeenAts, NOW)).toBe(3.5);
  });

  test("unaffected by input order", () => {
    const ascending = [daysAgo(10), daysAgo(6), daysAgo(4), daysAgo(1)];
    const shuffled = [daysAgo(1), daysAgo(10), daysAgo(4), daysAgo(6)];
    expect(medianAgeInDays(shuffled, NOW)).toBe(medianAgeInDays(ascending, NOW));
  });
});
