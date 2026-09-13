import { expect, test } from "bun:test";
import { oneOf, parseArgs, patchable, positiveInt, readSpec, required, requiredFlag } from "./args";

test("positionals and value flags come out separately", () => {
  const args = parseArgs(["m-1", "--reason", "audit finding"], { values: ["reason"] });
  expect(args.positionals).toEqual(["m-1"]);
  expect(args.flags.reason).toBe("audit finding");
});

test("--key=value is the same as --key value", () => {
  const args = parseArgs(["--reason=because"], { values: ["reason"] });
  expect(args.flags.reason).toBe("because");
});

test("boolean flags are on when present and absent otherwise", () => {
  const args = parseArgs(["--json"], readSpec());
  expect(args.booleans.has("json")).toBe(true);
  expect(parseArgs([], readSpec()).booleans.has("json")).toBe(false);
});

test("a boolean flag given a value is refused, rather than eating the next argument", () => {
  expect(() => parseArgs(["--json=yes"], readSpec())).toThrow(/takes no value/);
});

test("an unknown option is refused and the known ones are listed", () => {
  // The whole point: a mistyped --reasn must not leave the command running
  // with no reason at all.
  expect(() => parseArgs(["--reasn", "x"], { values: ["reason"] })).toThrow(
    /unknown option '--reasn'/,
  );
  expect(() => parseArgs(["--reasn", "x"], { values: ["reason"] })).toThrow(/--reason/);
});

test("a value flag with nothing after it is refused", () => {
  expect(() => parseArgs(["--reason"], { values: ["reason"] })).toThrow(/needs a value/);
});

test("repeatable flags keep every occurrence, and `flags` keeps the last", () => {
  const args = parseArgs(["--add", "curl", "--add", "jq"], { repeatable: ["add"] });
  expect(args.all.add).toEqual(["curl", "jq"]);
  expect(args.flags.add).toBe("jq");
});

test("required positionals and flags name what is missing", () => {
  const args = parseArgs([], { values: ["reason"] });
  expect(() => required(args, 0, "a machine", "usage: ...")).toThrow(/a machine is required/);
  expect(() => requiredFlag(args, "reason", "usage: ...")).toThrow(/--reason is required/);
});

test("oneOf and positiveInt reject what the API would reject anyway", () => {
  expect(oneOf("shell", ["file_recovery", "shell"], "level")).toBe("shell");
  expect(() => oneOf("root", ["file_recovery", "shell"], "level")).toThrow(/must be one of/);
  expect(positiveInt("25", "limit")).toBe(25);
  expect(() => positiveInt("0", "limit")).toThrow(/positive whole number/);
  expect(() => positiveInt("2.5", "limit")).toThrow(/positive whole number/);
});

test("patchable sends only the flags that were given", () => {
  const args = parseArgs(["--role", "admin"], { values: ["email", "role"] });
  expect(patchable(args, ["email", "role"])).toEqual({ role: "admin" });
});
