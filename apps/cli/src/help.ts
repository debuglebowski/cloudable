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
import { programName } from "./program";

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
    summary: "Sign in, and get an SSH certificate into your ssh-agent",
    options: [
      {
        flag: "--os-user <user>",
        description: "Unix user the certificate is valid for (default: cloudable)",
      },
      {
        flag: "--machine-scope all|<id>,<id>",
        description: "Machines the certificate may be used on (default: all)",
      },
    ],
    notes: [
      "Opens your browser to sign in with your password or your org's SSO, whichever it is set up for.",
      "One sign-in, two credentials: an API token every other command uses, and an SSH certificate lasting about 8 hours loaded into your running ssh-agent.",
      "The certificate needs SSH_AUTH_SOCK set. Without an agent everything else still works.",
      "No machine trusts the CA yet, so `ssh` cannot use the certificate. For a shell today, use `cloudable connect`.",
      "For CI, where there is no browser: set CLOUDABLE_TOKEN instead of running this.",
    ],
  },
  {
    name: "connect",
    summary: "Open a terminal on a machine",
    args: "<machine>",
    notes: [
      "You arrive as the machine's own Unix user, `cloudable`. There is no flag for this — one machine, one owner, one user.",
      "Rides the machine's outbound tunnel, the same path the console's web terminal uses. No inbound port is involved.",
      "Ctrl-] detaches and ends the session. Every other key goes to the remote shell, Ctrl-C included.",
      "The machine must be running and its tunnel daemon connected.",
    ],
  },
  {
    name: "logout",
    summary: "Forget the saved sign-in",
    notes: [
      "Clears the API token. The SSH certificate expires on its own within about 8 hours; `ssh-add -D` drops it now.",
    ],
  },
  {
    name: "whoami",
    summary: "Ask the control plane who you are",
    options: [{ flag: "--local", description: "Read the saved file instead of asking" }],
    notes: ["Without --local this is a live check, so an expired sign-in fails here."],
  },
  {
    name: "machines",
    summary: "Create, inspect and edit machines",
    subcommands: [
      {
        name: "list",
        summary: "List machines with state, region and image",
        options: [
          { flag: "--limit <n>", description: "Rows per page" },
          { flag: "--cursor <cursor>", description: "Continue from a previous page" },
        ],
      },
      { name: "get", summary: "Show one machine, with its resolved manifest", args: "<machine>" },
      {
        name: "create",
        summary: "Create a machine for a person",
        options: [
          { flag: "--owner <email|id>", description: "The one person who owns it (required)" },
          { flag: "--provider azure|docker|fake", description: "Where it runs (required)" },
          { flag: "--size <sku>", description: "Size SKU (required)" },
          { flag: "--image <image>", description: "Base image (required)" },
          { flag: "--region <region>", description: "Required for azure, ignored otherwise" },
          { flag: "--name <name>", description: "Defaults to a generated, org-unique name" },
        ],
        notes: [
          "A machine has exactly one owner, always a person. Check what this deployment can provision with `cloudable capabilities`.",
        ],
      },
      { name: "restart", summary: "Reboot a running machine", args: "<machine>" },
      {
        name: "upgrade",
        summary: "Move a machine to a new image",
        args: "<machine>",
        options: [
          { flag: "--image <image>", description: "Image to upgrade to (required)" },
          {
            flag: "--snapshot <scope>",
            description: "full (both disks, default) or shallow (your files only)",
          },
        ],
        notes: [
          "Snapshots first, then applies, then verifies.",
          "There is no automatic rollback yet: a failed verify leaves the machine on the new image, flagged for manual attention.",
        ],
      },
      {
        name: "archive",
        summary: "Snapshot a machine and archive it",
        args: "<machine>",
        options: [{ flag: "--approval <id>", description: "An approval already granted for this" }],
        notes: ["Machines are archived, never deleted. The data expires; the record is permanent."],
      },
      {
        name: "packages",
        summary: "The machine layer of the package manifest",
        subcommands: [
          {
            name: "list",
            summary: "Show the resolved manifest and where each entry came from",
            args: "<machine>",
          },
          {
            name: "set",
            summary: "Declare, pin, exclude or drop packages for one machine",
            args: "<machine>",
            options: [
              { flag: "--add <pkg>[@<ver>]", description: "Declare a package (repeatable)" },
              { flag: "--pin <pkg>[@<ver>]", description: "Declare it pinned (repeatable)" },
              { flag: "--remove <pkg>", description: "Drop this machine's entry (repeatable)" },
              { flag: "--exclude <pkg>", description: "Keep an org package off this machine" },
              { flag: "--include <pkg>", description: "Undo an exclusion (repeatable)" },
            ],
            notes: [
              "Edits desired state only.",
              '--remove falls back to the org entry; --exclude overrides it with "not here".',
              "Every edit is recorded. See it under the machine's manifest history.",
            ],
          },
        ],
      },
    ],
    notes: ["Every command takes a machine name or a machine id."],
  },
  {
    name: "sessions",
    summary: "Open terminal and SSH sessions",
    subcommands: [
      { name: "list", summary: "List sessions that are still open" },
      { name: "end", summary: "End a session now", args: "<sessionId>" },
    ],
  },
  {
    name: "certs",
    summary: "Live SSH certificates",
    subcommands: [
      { name: "list", summary: "Who holds a certificate, for what, expiring when" },
      {
        name: "revoke",
        summary: "Mark a certificate revoked",
        args: "<certificateId>",
        options: [{ flag: "--reason <reason>", description: "Why (required)" }],
        notes: [
          "sshd is not told. The certificate's own 8 hour lifetime is what actually stops it.",
        ],
      },
    ],
  },
  {
    name: "elevation",
    summary: "Ask for access to a machine you do not own",
    subcommands: [
      {
        name: "request",
        summary: "Request elevated access",
        options: [
          { flag: "--machine <machine>", description: "The machine (required)" },
          { flag: "--level file_recovery|shell", description: "How much access (required)" },
          { flag: "--reason <reason>", description: "Why (required)" },
        ],
      },
      { name: "list", summary: "List elevations in your org" },
      { name: "get", summary: "Show one elevation", args: "<id>" },
      {
        name: "sync",
        summary: "Pick up an approval decision",
        args: "<id>",
        notes: ["Deciding an approval does not grant the elevation by itself. This finishes it."],
      },
      { name: "expire", summary: "Give access back now", args: "<id>" },
    ],
  },
  {
    name: "snapshots",
    summary: "Snapshots left by archived and upgraded machines",
    subcommands: [
      {
        name: "list",
        summary: "List snapshots with retention and legal hold",
        options: [
          { flag: "--limit <n>", description: "Rows per page" },
          { flag: "--cursor <cursor>", description: "Continue from a previous page" },
        ],
      },
      { name: "get", summary: "Show one snapshot", args: "<snapshotId>" },
      { name: "cost", summary: "Estimate what a snapshot costs to keep", args: "<snapshotId>" },
      {
        name: "take",
        summary: "Take a snapshot of a machine now",
        args: "<machine>",
        options: [
          {
            flag: "--scope shallow|full",
            description: "shallow (default) copies the persistent volume; full adds the OS disk",
          },
        ],
        notes: ["The machine keeps running, so the copy is crash-consistent."],
      },
      {
        name: "ls",
        summary: "List files inside a snapshot",
        args: "<snapshotId> [path]",
        notes: [
          "Read-only, and the persistent disk only — the volume mounted at /home. Defaults to the machine's home directory.",
          "You must own the machine, or hold a granted elevation on it.",
        ],
      },
      {
        name: "cat",
        summary: "Print a file from inside a snapshot",
        args: "<snapshotId> <path>",
        notes: [
          "Writes raw bytes to stdout, so it pipes. Refuses a binary file or one over 1 MiB — use `get-file` for those.",
        ],
      },
      {
        name: "get-file",
        summary: "Recover a file out of a snapshot",
        args: "<snapshotId> <path>",
        options: [
          { flag: "--out <file>", description: "Where to write it (default: the file's own name)" },
        ],
      },
      {
        name: "restore",
        summary: "Restore a snapshot into a new machine, or onto an existing one",
        args: "<snapshotId>",
        options: [
          { flag: "--mode data", description: "What to restore (required)" },
          {
            flag: "--new-machine",
            description: "Restore into a new machine, leaving everything existing alone",
          },
          { flag: "--owner <person>", description: "Who owns the new machine (required with it)" },
          { flag: "--name <name>", description: "Name for the new machine (optional)" },
          { flag: "--target <machine>", description: "Or: an existing machine to restore onto" },
          {
            flag: "--confirm-destroys-data",
            description: "Required when that machine still has data to lose",
          },
          { flag: "--reason <reason>", description: "Why (required)" },
        ],
        notes: [
          "Pass exactly one of --new-machine or --target.",
          "Restoring into a new machine is the non-destructive option, and the only way to restore a running machine's snapshot without overwriting it.",
          "Only --mode data works. config and full are refused: nothing captures configuration, and secret bindings do not exist.",
          "Approval gated. It may come back pending; `restore-sync` finishes it.",
        ],
      },
      {
        name: "restore-sync",
        summary: "Resume a restore once its approval is decided",
        args: "<approvalId>",
      },
      {
        name: "legal-hold",
        summary: "Stop retention expiring a snapshot",
        subcommands: [
          {
            name: "set",
            summary: "Put a snapshot on legal hold",
            args: "<snapshotId>",
            options: [{ flag: "--reason <reason>", description: "Why (required)" }],
          },
          { name: "clear", summary: "Release a legal hold", args: "<snapshotId>" },
        ],
      },
    ],
  },
  {
    name: "people",
    summary: "The people who can own machines",
    subcommands: [
      { name: "list", summary: "List people, with role and source" },
      {
        name: "create",
        summary: "Add a person",
        options: [
          { flag: "--email <email>", description: "Their address (required)" },
          { flag: "--role <role>", description: "Their role (required)" },
        ],
      },
      {
        name: "update",
        summary: "Change a person's email or role",
        args: "<email|id>",
        options: [
          { flag: "--email <email>", description: "New address" },
          { flag: "--role <role>", description: "New role" },
        ],
        notes: ["Only people this org manages itself. A SCIM-sourced person is refused."],
      },
      { name: "activate", summary: "Let a person sign in again", args: "<email|id>" },
      {
        name: "deactivate",
        summary: "Stop a person signing in",
        args: "<email|id>",
        notes: ["Leaves their machines alone. `cloudable offboard start` archives those."],
      },
    ],
  },
  {
    name: "offboard",
    summary: "Archive everything a leaver owns",
    subcommands: [
      {
        name: "start",
        summary: "Start offboarding a person",
        args: "<email|id>",
        options: [{ flag: "--reason <reason>", description: "Why (required)" }],
        notes: ["Stops, unowns and archives every machine they own. Approval gated."],
      },
      {
        name: "sync",
        summary: "Resume offboarding once its approval is decided",
        args: "<approvalId>",
      },
    ],
  },
  {
    name: "approvals",
    summary: "The gate in front of privileged actions",
    subcommands: [
      {
        name: "list",
        summary: "List approvals",
        options: [
          { flag: "--status pending|approved|rejected|expired", description: "Filter by status" },
          { flag: "--limit <n>", description: "Rows per page" },
          { flag: "--cursor <cursor>", description: "Continue from a previous page" },
        ],
      },
      { name: "get", summary: "Show one approval", args: "<id>" },
      {
        name: "decide",
        summary: "Approve or reject",
        args: "<id>",
        options: [
          { flag: "--approve", description: "Approve it" },
          { flag: "--deny", description: "Reject it" },
          { flag: "--reason <reason>", description: "Why" },
        ],
        notes: ["Dual mode needs two different people. Your decision counts once."],
      },
      {
        name: "create",
        summary: "Raise an approval yourself",
        options: [
          {
            flag: "--action snapshot_restore|break_glass|admin_access|offboarding",
            description: "What it is for (required)",
          },
          { flag: "--reason <reason>", description: "Why (required)" },
          { flag: "--machine <machine>", description: "Machine it concerns" },
        ],
      },
    ],
  },
  {
    name: "org",
    summary: "Org-wide settings and the org package manifest",
    subcommands: [
      { name: "get", summary: "Show settings, logging tier and retention" },
      {
        name: "update",
        summary: "Change org settings",
        options: [
          { flag: "--name <name>", description: "Organisation name" },
          { flag: "--logging-tier 1|2|3", description: "Default logging tier" },
          { flag: "--retention-days <n>", description: "Default retention in days" },
          {
            flag: "--retention-location customer|cloudable_sweden_central",
            description: "Where snapshots live",
          },
          {
            flag: "--approval-mode <action>=<mode>",
            description: "none|single|dual per action (repeatable)",
          },
        ],
      },
      {
        name: "packages",
        summary: "The org layer every machine inherits",
        subcommands: [
          { name: "list", summary: "Show the org manifest" },
          {
            name: "set",
            summary: "Declare, pin or drop packages for the whole org",
            options: [
              { flag: "--add <pkg>[@<ver>]", description: "Declare a package (repeatable)" },
              { flag: "--pin <pkg>[@<ver>]", description: "Declare it pinned (repeatable)" },
              { flag: "--remove <pkg>", description: "Drop the org entry (repeatable)" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "config",
    summary: "Desired state, one setting or a whole file",
    subcommands: [
      {
        name: "set",
        summary: "Set one setting at org or machine scope",
        args: "<key> <value>",
        options: [
          { flag: "--machine <machine>", description: "Set it on one machine instead of the org" },
          { flag: "--pinned", description: "Stop lower scopes overriding it" },
        ],
        notes: ["Values are read as JSON when they look like it, otherwise as text."],
      },
      {
        name: "import",
        summary: "Apply a desired-state file",
        args: "<file|->",
        options: [
          { flag: "--correlation-id <id>", description: "Tie the changes together in the log" },
        ],
        notes: [
          'Takes an array of entries or a `{"entries": [...]}` document. `-` reads stdin.',
          "Same path as the console's own edits, so the events are the same.",
        ],
      },
    ],
    notes: ["Both write desired state only. Nothing here touches a live machine."],
  },
  {
    name: "catalog",
    summary: "Provider regions, images and sizes",
    subcommands: [
      {
        name: "list",
        summary: "List catalog entries",
        args: "region|image|sku",
        options: [{ flag: "--provider azure", description: "Provider (default: azure)" }],
      },
      { name: "sync", summary: "Re-read the catalog from Azure", args: "regions|sizes" },
    ],
  },
  {
    name: "capabilities",
    summary: "What this deployment can actually provision",
  },
  {
    name: "compliance",
    summary: "Checks, findings and control coverage",
    subcommands: [
      { name: "checks", summary: "The control map: what each control is evidenced by" },
      {
        name: "findings",
        summary: "Per-check findings, newest first",
        options: [{ flag: "--csv", description: "The export CSV instead of a table" }],
        notes: ["Exits non-zero when a check is failing, so CI can gate on it."],
      },
      {
        name: "override",
        summary: "Record a control as met, or clear that",
        args: "<controlId>",
        options: [
          {
            flag: "--status implemented|manual_action_required|not_covered",
            description: "What to report",
          },
          { flag: "--clear", description: "Go back to the computed status" },
        ],
      },
    ],
  },
  {
    name: "export",
    summary: "Evidence as CSV",
    subcommands: [
      {
        name: "asset-inventory",
        summary: "Every machine, owner and state",
        options: [{ flag: "--output <path>", description: "Write a file instead of stdout" }],
      },
      {
        name: "findings",
        summary: "Every finding, with age",
        options: [{ flag: "--output <path>", description: "Write a file instead of stdout" }],
      },
    ],
  },
  {
    name: "events",
    summary: "The append-only log, newest first",
    options: [
      { flag: "--limit <n>", description: "Rows per page (default: 50)" },
      { flag: "--cursor <cursor>", description: "Continue from a previous page" },
    ],
    notes: ["Events are never updated or deleted. Retention expires them; nothing edits them."],
  },
  {
    name: "integrations",
    summary: "Identity provider, clouds and secret stores",
    subcommands: [
      { name: "list", summary: "What this org has connected" },
      {
        name: "connect",
        summary: "Connect an integration",
        options: [
          { flag: "--kind idp|cloud|secret_store", description: "What kind (required)" },
          {
            flag: "--identifier <identifier>",
            description: "Tenant, subscription or vault (required)",
          },
          { flag: "--provider azure|docker|fake", description: "Required for kind cloud" },
          { flag: "--config <json>", description: "Non-secret configuration" },
        ],
        notes: ["No credential is ever stored. Federation only."],
      },
      { name: "disconnect", summary: "Disconnect an integration", args: "<id>" },
    ],
  },
  {
    name: "notifications",
    summary: "What you were told about your machines",
    subcommands: [
      {
        name: "list",
        summary: "List notifications",
        options: [{ flag: "--unread", description: "Only the unread ones" }],
      },
      { name: "read", summary: "Mark everything read" },
    ],
  },
  {
    name: "health",
    summary: "Check the control plane is up",
    notes: ["The only command that needs no session."],
  },
  {
    name: "version",
    summary: "Show the version, commit and runtime",
    notes: [
      "Also `--version` or `-v`. Reports the build it was compiled from, so a bug report can name one.",
    ],
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

/** `--version`/`-v` at the root, the same shape as the help flags. */
export function isVersionFlag(arg: string | undefined): boolean {
  return arg === "--version" || arg === "-v";
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
  return [programName(), ...chain.map((c) => c.name)].join(" ");
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
    `usage: ${programName()} <command> [subcommand] [options]`,
    "",
    "commands:",
    ...commandColumns(COMMANDS, false),
    "",
    "environment:",
    ...columns(ENVIRONMENT),
    "",
    "Most read commands take --json. Failures exit 2 usage, 3 not signed in, 4 denied, 5 not found, 6 refused, 7 server, 8 unreachable.",
    "",
    `Run \`${programName()} <command> --help\` for its subcommands and options.`,
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
  const prefix = chain.length === 0 ? programName() : commandPath(chain);
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
