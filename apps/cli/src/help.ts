// ---------------------------------------------------------------------------
// The command registry, and the help text rendered from it.
//
// One registry, so `cloudable`, `cloudable --help`, `cloudable help <cmd>`,
// `cloudable <cmd> --help` and the "unknown command" error all describe the
// same commands and cannot drift apart. `index.ts` routes from this registry
// as well, so anything listed here is a command that actually exists.
//
// Nothing here imports `config.ts`: help has to work before
// CLOUDABLE_API_URL is set, which is exactly when someone is most likely to
// be reading it.
// ---------------------------------------------------------------------------

export interface OptionSpec {
  readonly flag: string;
  readonly description: string;
}

export interface CommandSpec {
  readonly name: string;
  /** One line, shown next to the name in a command list. */
  readonly summary: string;
  /** Positional arguments, as they appear in the usage line. */
  readonly args?: string;
  readonly options?: ReadonlyArray<OptionSpec>;
  readonly subcommands?: ReadonlyArray<CommandSpec>;
  /** Paragraphs printed under the usage block. */
  readonly notes?: ReadonlyArray<string>;
}

export const TAGLINE = "cloudable — governed cloud Linux machines, one per person";

export const COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    name: "login",
    summary: "Get an SSH certificate into your ssh-agent",
    options: [
      {
        flag: "--os-user <user>",
        description: "Unix user the certificate is valid for (default: your local username)",
      },
      {
        flag: "--machine-scope all|<id>,<id>",
        description: "Machines the certificate may be used on (default: all)",
      },
    ],
    notes: [
      "Opens your browser to sign in, then loads a certificate that lasts about 8 hours into your running ssh-agent.",
      "Needs SSH_AUTH_SOCK set. Start an agent with `eval $(ssh-agent)` if it is not.",
    ],
  },
  {
    name: "auth",
    summary: "Sign in to the control plane API",
    subcommands: [
      {
        name: "login",
        summary: "Sign in with email and password",
        args: "[<email>] [<password>]",
        notes: ["Prompts for whatever you leave out. The password is not echoed."],
      },
      { name: "logout", summary: "Forget the saved session" },
      { name: "status", summary: "Show who you are signed in as" },
    ],
    notes: [
      "This is the session that `cloudable machines` uses. It is separate from `cloudable login`, which issues SSH certificates for reaching the machines themselves.",
    ],
  },
  {
    name: "machines",
    summary: "List your machines and trigger reconcile",
    subcommands: [
      { name: "list", summary: "List your machines with state, region and image" },
      {
        name: "reconcile",
        summary: "Apply a machine's desired state on the agent's next poll",
        args: "<machineId>",
        notes: [
          "Reconcile only closes gaps. It removes undeclared software, it never installs.",
          "The agent picks the change up on its next poll, roughly 30 seconds, not instantly.",
        ],
      },
    ],
    notes: ["Sign in first with `cloudable auth login`."],
  },
  {
    name: "help",
    summary: "Show help for a command",
    args: "[<command>] [<subcommand>]",
  },
];

const ENVIRONMENT: ReadonlyArray<OptionSpec> = [
  {
    flag: "CLOUDABLE_API_URL",
    description: "Control plane base URL. Required by every command that talks to the API.",
  },
];

export function isHelpFlag(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h";
}

/**
 * Help asked for after a command path: the flags, plus a bare `help`, so
 * `cloudable machines help` works too. Not used at the root, where `help` is
 * the command itself.
 */
export function wantsHelp(arg: string | undefined): boolean {
  return isHelpFlag(arg) || arg === "help";
}

export interface Resolved {
  /** Matched commands, outermost first. Empty when the first token is not a command. */
  readonly chain: ReadonlyArray<CommandSpec>;
  /** Tokens left over once the command path was consumed. */
  readonly rest: ReadonlyArray<string>;
}

/** Walks argv as far as it keeps naming commands and subcommands. */
export function resolve(argv: ReadonlyArray<string>): Resolved {
  const chain: CommandSpec[] = [];
  let candidates: ReadonlyArray<CommandSpec> | undefined = COMMANDS;
  let i = 0;
  while (candidates && i < argv.length) {
    const match: CommandSpec | undefined = candidates.find((c) => c.name === argv[i]);
    if (!match) break;
    chain.push(match);
    candidates = match.subcommands;
    i++;
  }
  return { chain, rest: argv.slice(i) };
}

export function commandPath(chain: ReadonlyArray<CommandSpec>): string {
  return ["cloudable", ...chain.map((c) => c.name)].join(" ");
}

function columns(rows: ReadonlyArray<OptionSpec>): string[] {
  const width = Math.max(...rows.map((r) => r.flag.length));
  return rows.map((r) => `  ${r.flag.padEnd(width)}   ${r.description}`);
}

/** A `name  summary` list. Arguments are shown for subcommand lists, not for the top-level index. */
function commandColumns(commands: ReadonlyArray<CommandSpec>, withArgs: boolean): string[] {
  return columns(
    commands.map((c) => ({
      flag: withArgs && c.args ? `${c.name} ${c.args}` : c.name,
      description: c.summary,
    })),
  );
}

export function renderRootHelp(): string {
  const lines = [
    TAGLINE,
    "",
    "usage: cloudable <command> [subcommand] [options]",
    "",
    "commands:",
    ...commandColumns(COMMANDS, false),
    "",
    "environment:",
    ...columns(ENVIRONMENT),
    "",
    "Run `cloudable <command> --help` for its subcommands and options.",
  ];
  return lines.join("\n");
}

export function renderCommandHelp(chain: ReadonlyArray<CommandSpec>): string {
  if (chain.length === 0) return renderRootHelp();
  const command = chain[chain.length - 1];
  if (!command) return renderRootHelp();
  const path = commandPath(chain);

  const usage = [path];
  if (command.subcommands) usage.push("<subcommand>");
  if (command.args) usage.push(command.args);
  for (const option of command.options ?? []) usage.push(`[${option.flag}]`);

  const lines = [`${path} — ${command.summary}`, "", `usage: ${usage.join(" ")}`];

  if (command.subcommands) {
    lines.push("", "subcommands:", ...commandColumns(command.subcommands, true));
  }
  if (command.options) {
    lines.push("", "options:", ...columns(command.options));
  }
  for (const note of command.notes ?? []) {
    lines.push("", note);
  }
  if (command.subcommands) {
    lines.push("", `Run \`${path} <subcommand> --help\` for details.`);
  }
  return lines.join("\n");
}

/** Levenshtein distance, used only to offer a "did you mean" on a typo. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(
        Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

export function suggest(input: string, candidates: ReadonlyArray<CommandSpec>): string | undefined {
  let best: { name: string; score: number } | undefined;
  for (const candidate of candidates) {
    const score = candidate.name.startsWith(input) ? 0 : distance(input, candidate.name);
    if (score <= 3 && (!best || score < best.score)) best = { name: candidate.name, score };
  }
  return best?.name;
}

/**
 * The message for a word that is not a command. Thrown, so `main`'s handler
 * prints it to stderr and exits non-zero — an unknown command is a failure,
 * not output.
 */
export function unknownCommandMessage(
  input: string,
  chain: ReadonlyArray<CommandSpec>,
  candidates: ReadonlyArray<CommandSpec>,
): string {
  const what = chain.length === 0 ? "command" : "subcommand";
  const prefix = chain.length === 0 ? "cloudable" : commandPath(chain);
  const guess = suggest(input, candidates);
  const lines = [`unknown ${what} '${input}' for \`${prefix}\``];
  if (guess) lines.push("", `did you mean '${guess}'?`);
  lines.push(
    "",
    `${what}s:`,
    ...commandColumns(candidates, false),
    "",
    `Run \`${prefix} --help\` for more.`,
  );
  return lines.join("\n");
}
