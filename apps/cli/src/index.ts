// ---------------------------------------------------------------------------
// Entry point and router. The command path is resolved against the registry
// in `help.ts`, so the commands that run and the commands that help lists
// are the same list. A word that is not in the registry never reaches a
// command module.
//
// Help and argument errors must work without CLOUDABLE_API_URL set: a
// command module is only imported once its command is the one being run, and
// `config.ts` only reads the variable when a request is actually made.
// ---------------------------------------------------------------------------
import { HANDLERS } from "./dispatch";
import {
  COMMANDS,
  commandPath,
  isHelpFlag,
  renderCommandHelp,
  renderRootHelp,
  resolve,
  unknownCommandMessage,
  wantsHelp,
} from "./help";

/** A bad invocation. Printed to stderr, exits non-zero — it is a failure, not output. */
class UsageError extends Error {}

/** Prints help for whatever `cloudable help ...` names. */
function runHelpCommand(argv: ReadonlyArray<string>): void {
  const { chain, rest } = resolve(argv);
  if (rest.length > 0 && rest[0] !== undefined) {
    const candidates = chain[chain.length - 1]?.subcommands ?? COMMANDS;
    throw new UsageError(unknownCommandMessage(rest[0], chain, candidates));
  }
  console.log(chain.length === 0 ? renderRootHelp() : renderCommandHelp(chain));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || isHelpFlag(argv[0])) {
    console.log(renderRootHelp());
    return;
  }

  const { chain, rest } = resolve(argv);
  const command = chain[0];
  if (!command) {
    throw new UsageError(unknownCommandMessage(argv[0] ?? "", [], COMMANDS));
  }

  if (command.name === "help") {
    runHelpCommand(rest);
    return;
  }

  if (wantsHelp(rest[0])) {
    console.log(renderCommandHelp(chain));
    return;
  }

  const leaf = chain[chain.length - 1];
  if (leaf?.subcommands) {
    // `resolve` stopped here, so either nothing followed or what followed is
    // not one of this command's subcommands.
    if (rest[0] !== undefined) {
      throw new UsageError(unknownCommandMessage(rest[0], chain, leaf.subcommands));
    }
    throw new UsageError(
      `${commandPath(chain)} needs a subcommand.\n\n${renderCommandHelp(chain)}`,
    );
  }

  const path = chain.map((c) => c.name).join(" ");
  const handler = HANDLERS[path];
  // dispatch.test.ts holds the registry and this table to the same set of
  // commands, so this is a bug in the CLI, not in what the user typed.
  if (!handler) throw new Error(`no implementation for '${path}'`);
  await handler(rest);
}

main().catch((err: unknown) => {
  // A clean one-line message, not a raw stack trace, for expected failures
  // (not logged in, a 4xx from the API, bad args) — this is a CLI, not a
  // stack a developer debugging this codebase needs to see.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
