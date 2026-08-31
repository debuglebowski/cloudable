// ---------------------------------------------------------------------------
// The CP -> agent tunnel-signal channel's control-plane half (docs/spec.md
// §8.2/§11.1; see `packages/contracts/src/domains/tunnel-signal.ts` for the
// wire type and the full reasoning for why this is a separate channel from
// `wake`, not a repurposed one).
//
// Design: an outbound long-poll the agent already holds open, not a second
// websocket. `HttpApiEndpoint`/`HttpApiGroup` only model HTTP verbs — the
// exact obstacle `agent-wake.ts` hit trying to add a websocket upgrade to
// this same router — but a long poll needs no upgrade at all: it's a plain
// `GET` that this service holds pending (via a `Deferred`) until either a
// signal arrives or a timeout elapses, which fits `HttpApiEndpoint` exactly
// like `poll`/`report` already do. This sidesteps the obstacle rather than
// working around it, and keeps the tunnel-signal handler
// (`http/handlers/tunnel-signal.ts`) bearer-authenticated the same way
// `/poll`/`/report` are, no new auth mechanism needed.
//
// Per-machine state only, in-memory, not persisted — same tradeoff
// `TunnelRegistry`-style in-memory connection state would have (a
// horizontally-scaled control plane would need this shared, e.g. via
// pub/sub, for a machine's long-poll to land on a different instance than
// the one that minted its session — out of scope for this build's
// single-instance deployment model). A dropped/restarted control plane
// process simply loses any signal that hadn't been delivered yet; the
// browser side of a lost `session_waiting` sees `daemon_not_connected` (or
// simply nothing happens) and the person retries — no worse than any other
// in-memory, best-effort fast path in this codebase (`wake`'s own design).
//
// Concurrency note (this file's own hard requirement): `push` and `next`
// each touch the same per-machine state through more than one step, so
// naively splitting "check the queue" from "register a waiter" (or "pop a
// waiter" from "resolve it") across separate `Ref` operations leaves a gap
// a concurrent call on the other function can land in. Two failure modes
// that shape matters for, both closed below:
//   1. A `push` racing between `next`'s "queue was empty" check and its
//      "register a waiter" write would enqueue a message nobody currently
//      waiting would ever be told about until their own long poll times
//      out — a real, observed-in-review delay bug.
//   2. Worse: a `next` call whose long poll has *already* timed out (or
//      whose connection was interrupted) but whose waiter hasn't been
//      unregistered yet can have a concurrent `push` "resolve" it anyway —
//      `push` would believe it delivered the message and never queue it,
//      while nobody is left listening. The message is gone for good. See
//      `next`'s own comment for how completing the *same* `Deferred` from
//      both the delivery path and the timeout path (rather than one side
//      merely "giving up" on it) closes this.
// ---------------------------------------------------------------------------
import type { TunnelSignalMessage } from "@cloudable/contracts";
import { Deferred, Duration, Effect, Fiber, Ref } from "effect";

/** How long the agent's long poll is held open before returning `signal:
 * null` and letting the agent reconnect immediately. Comfortably under any
 * reasonable HTTP client/load-balancer timeout (unlike the ~30s `/poll`
 * cadence, this connection is meant to be held open continuously). */
export const TUNNEL_SIGNAL_LONG_POLL_TIMEOUT = Duration.seconds(25);

/** Caps how many undelivered signals a machine can accumulate while no long
 * poll is parked for it (dropping the oldest on overflow) — a generous
 * bound for what should, in practice, never exceed a handful: a session
 * being minted or terminated is a person-paced event, not a firehose. */
const MAX_QUEUED_PER_MACHINE = 20;

/** A parked `next()` call's own completion cell. Resolved with a real message by `push`, or
 * with `null` by `next`'s own timeout — whichever gets there first via `Deferred.succeed`'s
 * atomic "first caller wins" semantics is authoritative, and the loser's attempt reports back
 * `false` rather than silently discarding anything (see this file's header comment). */
type Waiter = Deferred.Deferred<TunnelSignalMessage | null>;

interface MachineSignalState {
  readonly queue: readonly TunnelSignalMessage[];
  readonly waiters: readonly Waiter[];
}

const emptyState: MachineSignalState = { queue: [], waiters: [] };

/** Per-machine entries are removed outright once both empty, rather than left behind as an
 * inert `{queue: [], waiters: []}` forever — every machine that has ever minted a session
 * (including one later archived, which per CLAUDE.md invariant 6 exists permanently in
 * `machines`) would otherwise leave a permanent entry here with nothing to ever clean it up. */
const withPruned = (
  map: ReadonlyMap<string, MachineSignalState>,
  machineId: string,
  entry: MachineSignalState,
): Map<string, MachineSignalState> => {
  const next = new Map(map);
  if (entry.queue.length === 0 && entry.waiters.length === 0) {
    next.delete(machineId);
  } else {
    next.set(machineId, entry);
  }
  return next;
};

export class TunnelSignal extends Effect.Service<TunnelSignal>()("TunnelSignal", {
  effect: Effect.gen(function* () {
    const state = yield* Ref.make(new Map<string, MachineSignalState>());

    /**
     * Delivers `message` to `machineId`'s tunnel-signal channel. If a long poll is currently
     * parked waiting for this machine, resolves it — but only actually counts that as
     * delivered if `Deferred.succeed` reports it won the race (`true`); a waiter that already
     * timed out or was abandoned by a dropped connection reports `false` (see `next`), and
     * this falls through to trying the next waiter, or queuing the message if none are left.
     * Queues for the next long poll to pick up otherwise — never dropped just because nobody
     * happened to be waiting at this exact instant.
     */
    const push = (machineId: string, message: TunnelSignalMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const waiter = yield* Ref.modify(state, (map) => {
            const existing = map.get(machineId) ?? emptyState;
            const [candidate, ...rest] = existing.waiters;
            if (!candidate) return [undefined, map];
            return [candidate, withPruned(map, machineId, { ...existing, waiters: rest })];
          });

          if (!waiter) {
            // No live waiter to hand this to — queue it for whoever calls `next` next.
            yield* Ref.update(state, (map) => {
              const existing = map.get(machineId) ?? emptyState;
              const queue = [...existing.queue, message].slice(-MAX_QUEUED_PER_MACHINE);
              return withPruned(map, machineId, { ...existing, queue });
            });
            return;
          }

          const delivered = yield* Deferred.succeed(waiter, message);
          if (delivered) return; // this waiter genuinely received it — done.
          // Else: `waiter` had already been completed (its own timeout/interruption cleanup
          // got there first, concurrently) — it was already popped off above, so just try
          // whatever waiter is next in line (or fall through to queuing) rather than looping
          // forever on the same dead one.
        }
      });

    /**
     * Returns the next queued signal for `machineId` immediately if one is already queued,
     * otherwise parks until one arrives or `TUNNEL_SIGNAL_LONG_POLL_TIMEOUT` elapses (`null`
     * — not an error; a timed-out long poll is the expected, common case). The handler
     * calling this is expected to loop: call again immediately after every response, signal
     * or not.
     *
     * The initial "is one already queued, or do I need to register as a waiter" check is one
     * single atomic `Ref.modify` (not a check followed by a separate registration) — a
     * concurrent `push` can only ever observe this call as fully parked or not yet started,
     * never caught in between, which is what makes `push`'s own "queue vs. resolve a waiter"
     * choice always correct.
     */
    const next = (machineId: string): Effect.Effect<TunnelSignalMessage | null> =>
      Effect.gen(function* () {
        const deferred: Waiter = yield* Deferred.make<TunnelSignalMessage | null>();

        const immediate = yield* Ref.modify(state, (map) => {
          const existing = map.get(machineId) ?? emptyState;
          const [message, ...rest] = existing.queue;
          if (message !== undefined) {
            return [message, withPruned(map, machineId, { ...existing, queue: rest })];
          }
          const next = new Map(map);
          next.set(machineId, { ...existing, waiters: [...existing.waiters, deferred] });
          return [undefined, next];
        });

        if (immediate !== undefined) return immediate;

        // Removes `deferred` from the waiters array if it's still there — a no-op if `push`
        // already popped it off. Safe (and necessary) to run regardless of which side actually
        // completed the deferred: it's the array-side half of this waiter's cleanup, distinct
        // from completing the deferred itself (below).
        const forget = Ref.update(state, (map) => {
          const existing = map.get(machineId);
          if (!existing) return map;
          return withPruned(map, machineId, {
            ...existing,
            waiters: existing.waiters.filter((w) => w !== deferred),
          });
        });

        // This fiber's own timeout, expressed as *completing this exact deferred with
        // `null`* rather than merely racing/abandoning the wait — the critical difference
        // from a plain `Effect.timeoutTo`. Whichever of this and a concurrent `push` calls
        // `Deferred.succeed` first is the one that actually determines this call's result;
        // the loser's call returns `false`, which is exactly the signal `push` needs to know
        // its message did *not* land here and it should try elsewhere instead of discarding
        // it. This is what makes the interrupted/timed-out-waiter data-loss race impossible:
        // there is no window where a waiter is "logically dead" but still `Deferred.succeed`-able
        // by a racing `push`.
        const timeoutFiber = yield* Effect.fork(
          Effect.sleep(TUNNEL_SIGNAL_LONG_POLL_TIMEOUT).pipe(
            Effect.zipRight(Deferred.succeed(deferred, null)),
          ),
        );

        return yield* Deferred.await(deferred).pipe(
          // Runs on every exit — normal completion (by `push`, or by the forked timeout
          // above) and external interruption alike (the long poll's own HTTP connection
          // dropping mid-wait, e.g. the agent process being killed) all need the same two
          // things: stop the now-pointless timeout fiber, and forget this waiter.
          Effect.ensuring(Effect.all([Fiber.interrupt(timeoutFiber), forget], { discard: true })),
        );
      });

    return { push, next } as const;
  }),
}) {}
