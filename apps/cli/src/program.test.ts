import { expect, test } from "bun:test";
import { CANONICAL_NAME, invokedAsAlias, programName, usageFor } from "./program";

test("the invoked name is taken from argv0, path and all", () => {
  expect(programName("/usr/local/bin/cloudable")).toBe("cloudable");
  expect(programName("/usr/local/bin/cable")).toBe("cable");
  expect(programName("./cable")).toBe("cable");
  expect(programName("cable")).toBe("cable");
  expect(programName("C:\\tools\\cable.exe")).toBe("cable");
});

test("anything that is not a known name reads as cloudable", () => {
  // Running from source (argv0 is the runtime), a test file, a renamed binary.
  expect(programName("/opt/homebrew/bin/bun")).toBe(CANONICAL_NAME);
  expect(programName("/repo/apps/cli/src/index.ts")).toBe(CANONICAL_NAME);
  expect(programName("cl")).toBe(CANONICAL_NAME);
  expect(programName(undefined)).toBe(CANONICAL_NAME);
  expect(programName("")).toBe(CANONICAL_NAME);
});

test("an alias is recognised as one", () => {
  expect(invokedAsAlias("cable")).toBe(true);
  expect(invokedAsAlias("cloudable")).toBe(false);
  expect(invokedAsAlias("/opt/homebrew/bin/bun")).toBe(false);
});

test("usage lines are built from the name in use", () => {
  // Under `bun test` argv0 is the runtime, so this is the canonical name.
  expect(usageFor("machines get <machine>")).toBe(
    `usage: ${CANONICAL_NAME} machines get <machine>`,
  );
});
