// ---------------------------------------------------------------------------
// Flag parsing, shared by every command.
//
// Each command declares the flags it takes, so `--reasn` is reported as an
// unknown option instead of being silently ignored and the command running
// with a missing reason. `--json` is understood everywhere a command can
// print a machine-readable result; it is added to the spec by `readSpec`.
// ---------------------------------------------------------------------------
import { UsageError } from "./errors";

export interface ArgSpec {
  /** Flags that take a value: `--reason <text>`. */
  readonly values?: ReadonlyArray<string>;
  /** Flags that are on or off: `--json`. */
  readonly booleans?: ReadonlyArray<string>;
  /** Value flags that may be repeated, collected in order. */
  readonly repeatable?: ReadonlyArray<string>;
}

export interface Args {
  readonly positionals: ReadonlyArray<string>;
  /** Last wins for a repeated value flag; use `all` for every occurrence. */
  readonly flags: Readonly<Record<string, string>>;
  readonly all: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly booleans: ReadonlySet<string>;
}

/** Adds `--json` to a spec, for commands whose output can be either shape. */
export function readSpec(spec: ArgSpec = {}): ArgSpec {
  return { ...spec, booleans: [...(spec.booleans ?? []), "json"] };
}

export function parseArgs(argv: ReadonlyArray<string>, spec: ArgSpec = {}): Args {
  const values = new Set([...(spec.values ?? []), ...(spec.repeatable ?? [])]);
  const booleans = new Set(spec.booleans ?? []);
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const all: Record<string, string[]> = {};
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    // `--key=value` and `--key value` are the same thing.
    const equals = arg.indexOf("=");
    const key = (equals === -1 ? arg.slice(2) : arg.slice(2, equals)).trim();
    const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);

    if (booleans.has(key)) {
      if (inlineValue !== undefined) throw new UsageError(`--${key} takes no value`);
      seen.add(key);
      continue;
    }
    if (!values.has(key)) {
      const known = [...values, ...booleans].sort();
      throw new UsageError(
        `unknown option '--${key}'${known.length > 0 ? `\n\noptions: ${known.map((k) => `--${k}`).join(", ")}` : ""}`,
      );
    }

    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new UsageError(`--${key} needs a value`);
    flags[key] = value;
    const occurrences = all[key] ?? [];
    occurrences.push(value);
    all[key] = occurrences;
  }

  return { positionals, flags, all, booleans: seen };
}

/** A positional that has to be there. */
export function required(args: Args, index: number, name: string, usage: string): string {
  const value = args.positionals[index];
  if (value === undefined || value === "") throw new UsageError(`${name} is required\n\n${usage}`);
  return value;
}

/** A flag that has to be there. */
export function requiredFlag(args: Args, key: string, usage: string): string {
  const value = args.flags[key];
  if (value === undefined || value === "") throw new UsageError(`--${key} is required\n\n${usage}`);
  return value;
}

export function oneOf<T extends string>(value: string, allowed: ReadonlyArray<T>, key: string): T {
  if (!(allowed as ReadonlyArray<string>).includes(value)) {
    throw new UsageError(`--${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function positiveInt(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${key} must be a positive whole number`);
  }
  return parsed;
}

/** Only the flags actually given, for a PATCH that means "change just these". */
export function patchable(args: Args, keys: ReadonlyArray<string>): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const key of keys) {
    const value = args.flags[key];
    if (value !== undefined) payload[key] = value;
  }
  return payload;
}
