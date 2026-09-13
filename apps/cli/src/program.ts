// ---------------------------------------------------------------------------
// What this program is called when it runs.
//
// `cable` is an alias for `cloudable` — the same binary under a second name
// (README's CLI section). Help and usage lines print the name that was
// actually typed, so an alias never tells you to type something else.
//
// `process.argv0` is the invoked name, unlike `process.argv[1]`, which in a
// `bun build --compile` binary is always the bundled entry path and says
// nothing about how the binary was reached. argv0 survives both a symlink and
// a PATH lookup, which is exactly how an alias arrives.
//
// The accepted names are a fixed list: run from source, argv0 is `bun`, and a
// binary someone renamed to something else shouldn't make help text
// unpredictable. Anything unrecognised reads as `cloudable`.
// ---------------------------------------------------------------------------

export const CANONICAL_NAME = "cloudable";
export const ALIASES: ReadonlyArray<string> = ["cable"];

const KNOWN = new Set([CANONICAL_NAME, ...ALIASES]);

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? "";
}

/** The name to print. Takes argv0 explicitly so a test can pass one in. */
export function programName(argv0: string | undefined = process.argv0): string {
  const invoked = basename(argv0 ?? "").replace(/\.exe$/i, "");
  return KNOWN.has(invoked) ? invoked : CANONICAL_NAME;
}

/** True when this run came in under an alias rather than the canonical name. */
export function invokedAsAlias(argv0: string | undefined = process.argv0): boolean {
  return programName(argv0) !== CANONICAL_NAME;
}

/** `usage: cloudable machines get <machine>`, in whichever name was typed. */
export function usageFor(rest: string): string {
  return `usage: ${programName()} ${rest}`;
}
