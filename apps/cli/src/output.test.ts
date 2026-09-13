import { expect, test } from "bun:test";
import { NONE, dash, shortTime } from "./output";

test("an absent value reads as absent, not as an empty column", () => {
  expect(dash(null)).toBe(NONE);
  expect(dash(undefined)).toBe(NONE);
  expect(dash("")).toBe(NONE);
  expect(dash(0)).toBe("0");
  expect(dash("eu-north")).toBe("eu-north");
});

test("times print to the minute in UTC", () => {
  expect(shortTime("2026-09-13T13:26:49.123Z")).toBe("2026-09-13 13:26");
  expect(shortTime(null)).toBe(NONE);
  // Not a date: show what we were given rather than "Invalid Date".
  expect(shortTime("soon")).toBe("soon");
});
