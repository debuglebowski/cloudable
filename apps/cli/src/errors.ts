// ---------------------------------------------------------------------------
// Failure shapes, and the exit code each one leaves behind.
//
// One `catch` in index.ts prints these, so a script can tell a denial from a
// typo from an unreachable control plane without parsing the message:
//
//   2  the invocation was wrong (unknown command, missing flag, bad value)
//   3  not signed in, or the session has expired
//   4  denied — signed in, not allowed
//   5  the thing named does not exist
//   6  refused because of current state (a pin, a conflict, a rule)
//   7  the control plane failed
//   8  the control plane could not be reached
//   1  anything else
// ---------------------------------------------------------------------------

export const EXIT = {
  usage: 2,
  unauthenticated: 3,
  denied: 4,
  notFound: 5,
  conflict: 6,
  serverError: 7,
  unreachable: 8,
  failure: 1,
} as const;

/** Carries the exit code index.ts should use. */
export interface ExitCoded {
  readonly exitCode: number;
}

export function exitCodeOf(error: unknown): number {
  return typeof error === "object" && error !== null && "exitCode" in error
    ? Number((error as ExitCoded).exitCode)
    : EXIT.failure;
}

/** A bad invocation. Its message is expected to include usage. */
export class UsageError extends Error {
  readonly exitCode = EXIT.usage;
}

/** A refusal this CLI decided on its own, before or instead of a request. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.failure,
  ) {
    super(message);
  }
}
