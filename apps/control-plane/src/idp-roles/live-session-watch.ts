import { Clock, Duration, Effect, Either, Ref } from "effect";
import type { IdpRolesConfig } from "./config";
import type { ModeFence } from "./mode-fence";
import { type PersonStanding, checkStanding, roleEvidenceDeadline } from "./standing";

/**
 * How often a live tunnel re-reads its person's standing between deadlines, so a revocation (a
 * refused sign-in, the mode switching on, a deactivation) ends it within this, not only at the
 * next sweep. Each read is one primary-key lookup per live session.
 */
export const REVOCATION_POLL_MS = 10_000;

/** A standing read that takes longer than this counts as failed, and fails closed. */
export const STANDING_READ_TIMEOUT_MS = 5_000;

export interface StandingRead {
  readonly person: PersonStanding | undefined;
  readonly fence: ModeFence;
}

/**
 * The deadline a live session may run to, from a standing read, or `null` when it may not run
 * at all. `issuedAtMs` is when the session was minted: a revocation after that ends it, even if
 * the person has signed in again since.
 */
export const allowedUntil = (
  read: StandingRead,
  issuedAtMs: number,
  nowMs: number,
  idpRoles: IdpRolesConfig,
): number | null => {
  if (read.fence !== "ok" || read.person === undefined) return null;
  if (checkStanding(read.person, issuedAtMs, nowMs, idpRoles) !== null) return null;
  return roleEvidenceDeadline(read.person, idpRoles)?.getTime() ?? null;
};

export interface LiveSessionWatch {
  readonly idpRoles: IdpRolesConfig;
  /** When the session was minted. */
  readonly issuedAtMs: number;
  /** Reads the person's standing and the mode fence, fresh. May fail; that fails closed. */
  readonly readStanding: Effect.Effect<StandingRead, unknown>;
  /** Ends the session and closes its transport. Must close the transport even if recording
   * the end fails. Called at most once. */
  readonly onLapse: Effect.Effect<void>;
  /** The session's deadline, set by the caller from the attach-time read before the session
   * carries any traffic, and moved forward here when a fresh SSO sign-in extends it. The
   * per-frame gates read it (`isPastDeadline`). */
  readonly deadline: Ref.Ref<number>;
}

/**
 * Keeps one live terminal, files or SSH tunnel inside its person's standing, with roles from the
 * identity provider on.
 *
 * - At the deadline it ends the session without reading anything first, so a slow or failing
 *   database cannot stretch a session past its deadline.
 * - Before the deadline it re-reads the person every `REVOCATION_POLL_MS`. Revoked credentials,
 *   deactivation, a mode mismatch, stale evidence, a read failure or a read slower than
 *   `STANDING_READ_TIMEOUT_MS` end the session. A fresh SSO sign-in moves the deadline forward.
 *
 * Time comes from Effect's `Clock`, so tests drive it exactly.
 */
export const watchLiveSession = (watch: LiveSessionWatch): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      const deadline = yield* Ref.get(watch.deadline);
      if (now >= deadline) break;
      yield* Effect.sleep(Duration.millis(Math.min(deadline - now, REVOCATION_POLL_MS)));

      const woke = yield* Clock.currentTimeMillis;
      if (woke >= (yield* Ref.get(watch.deadline))) break;

      const read = yield* watch.readStanding.pipe(
        Effect.timeoutFail({
          duration: Duration.millis(STANDING_READ_TIMEOUT_MS),
          onTimeout: () => "standing_read_timeout",
        }),
        Effect.sandbox,
        Effect.either,
      );
      if (Either.isLeft(read)) break;
      const checkedAt = yield* Clock.currentTimeMillis;
      const until = allowedUntil(read.right, watch.issuedAtMs, checkedAt, watch.idpRoles);
      if (until === null || checkedAt >= until) break;
      yield* Ref.set(watch.deadline, until);
    }
    yield* Ref.set(watch.deadline, Number.NEGATIVE_INFINITY);
    yield* watch.onLapse;
  });

/** The per-frame gate, both directions: true once the session's deadline has passed. */
export const isPastDeadline = (deadline: Ref.Ref<number>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return now >= (yield* Ref.get(deadline));
  });
