import { expect, test } from "bun:test";
import { parseValue } from "./settings";

test("a value that looks like JSON is sent as JSON", () => {
  expect(parseValue("3")).toBe(3);
  expect(parseValue("true")).toBe(true);
  expect(parseValue("null")).toBeNull();
  expect(parseValue('["/home/kalle"]')).toEqual(["/home/kalle"]);
  expect(parseValue('{"webTerminal":true}')).toEqual({ webTerminal: true });
});

test("anything else is sent as text", () => {
  expect(parseValue("ubuntu-24.04")).toBe("ubuntu-24.04");
  expect(parseValue("")).toBe("");
});
