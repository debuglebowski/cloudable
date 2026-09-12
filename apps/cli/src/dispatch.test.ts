import { expect, test } from "bun:test";
import { HANDLERS } from "./dispatch";
import { COMMANDS, type CommandSpec } from "./help";

/** Every runnable path in the registry: the leaves, minus `help`, which index.ts answers itself. */
function runnablePaths(commands: ReadonlyArray<CommandSpec>, prefix: string[] = []): string[] {
  return commands.flatMap((c) => {
    const path = [...prefix, c.name];
    if (c.subcommands) return runnablePaths(c.subcommands, path);
    return c.name === "help" && prefix.length === 0 ? [] : [path.join(" ")];
  });
}

test("the registry and the dispatch table describe the same commands", () => {
  expect(Object.keys(HANDLERS).sort()).toEqual(runnablePaths(COMMANDS).sort());
});
