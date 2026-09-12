import { expect, test } from "bun:test";
import {
  COMMANDS,
  type CommandSpec,
  isHelpFlag,
  renderCommandHelp,
  renderRootHelp,
  resolve,
  suggest,
  unknownCommandMessage,
  wantsHelp,
} from "./help";

function command(name: string): CommandSpec {
  const found = COMMANDS.find((c) => c.name === name);
  if (!found) throw new Error(`no such command in the registry: ${name}`);
  return found;
}

test("root help lists every command and the required env var", () => {
  const help = renderRootHelp();
  for (const command of COMMANDS) {
    expect(help).toContain(command.name);
    expect(help).toContain(command.summary);
  }
  expect(help).toContain("CLOUDABLE_API_URL");
});

test("every command and subcommand renders help with a usage line", () => {
  for (const command of COMMANDS) {
    const help = renderCommandHelp([command]);
    expect(help).toContain(`usage: cloudable ${command.name}`);
    for (const sub of command.subcommands ?? []) {
      const subHelp = renderCommandHelp([command, sub]);
      expect(subHelp).toContain(`usage: cloudable ${command.name} ${sub.name}`);
    }
  }
});

test("machines help shows both subcommands, login help shows both options", () => {
  const machines = renderCommandHelp(resolve(["machines"]).chain);
  expect(machines).toContain("list");
  expect(machines).toContain("reconcile");

  const login = renderCommandHelp(resolve(["login"]).chain);
  expect(login).toContain("--os-user");
  expect(login).toContain("--machine-scope");
});

test("resolve consumes the command path and leaves the arguments", () => {
  const { chain, rest } = resolve(["machines", "reconcile", "m-1"]);
  expect(chain.map((c) => c.name)).toEqual(["machines", "reconcile"]);
  expect(rest).toEqual(["m-1"]);
});

test("resolve stops at the command when the next word is not one of its subcommands", () => {
  const { chain, rest } = resolve(["machines", "lst"]);
  expect(chain.map((c) => c.name)).toEqual(["machines"]);
  expect(rest).toEqual(["lst"]);
});

test("resolve returns an empty chain for a word that is not a command", () => {
  expect(resolve(["banana"]).chain).toEqual([]);
});

test("a typo suggests the nearest command, nonsense suggests nothing", () => {
  expect(suggest("machnes", COMMANDS)).toBe("machines");
  expect(suggest("mach", COMMANDS)).toBe("machines");
  expect(suggest("xyzzy", COMMANDS)).toBeUndefined();
});

test("unknown command message names the typo, the guess and every command", () => {
  const message = unknownCommandMessage("machnes", [], COMMANDS);
  expect(message).toContain("unknown command 'machnes'");
  expect(message).toContain("did you mean 'machines'?");
  for (const command of COMMANDS) expect(message).toContain(command.name);
});

test("unknown subcommand message is scoped to that command's subcommands", () => {
  const machines = command("machines");
  const message = unknownCommandMessage("lst", [machines], machines.subcommands ?? []);
  expect(message).toContain("unknown subcommand 'lst' for `cloudable machines`");
  expect(message).toContain("did you mean 'list'?");
  expect(message).toContain("cloudable machines --help");
});

test("help flags are recognised, other arguments are not", () => {
  expect(isHelpFlag("--help")).toBe(true);
  expect(isHelpFlag("-h")).toBe(true);
  expect(isHelpFlag("--os-user")).toBe(false);
  expect(isHelpFlag(undefined)).toBe(false);
});

test("a bare `help` asks for help after a command, but is not a flag at the root", () => {
  // At the root `help` is the command, so the flag check must not claim it.
  expect(isHelpFlag("help")).toBe(false);
  expect(wantsHelp("help")).toBe(true);
  expect(wantsHelp("--help")).toBe(true);
  expect(wantsHelp("list")).toBe(false);
});
