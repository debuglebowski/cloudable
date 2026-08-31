import { describe, expect, test } from "bun:test";
import { Effect, Either, Fiber } from "effect";
import { TunnelSignal } from "./signal";

const runWith = <A>(effect: Effect.Effect<A, unknown, TunnelSignal>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TunnelSignal.Default));

describe("TunnelSignal", () => {
  test("a long poll already parked for a machine is resolved immediately when a signal is pushed", async () => {
    const result = await runWith(
      Effect.gen(function* () {
        const signal = yield* TunnelSignal;
        // Forked (not a separate `Effect.provide`) so this genuinely shares the same
        // service instance/state as the `push` below — the whole point of this test.
        const waiting = yield* Effect.fork(signal.next("m-1"));
        // Let the forked fiber actually run and park (register itself as a waiter)
        // before pushing — otherwise this would race the queue path instead of the
        // parked-waiter path this test exists to exercise.
        yield* Effect.sleep(20);
        yield* signal.push("m-1", { type: "session_waiting", sessionId: "s-1" });
        return yield* Fiber.join(waiting);
      }),
    );
    expect(result).toEqual({ type: "session_waiting", sessionId: "s-1" });
  });

  test("a signal pushed with nobody waiting is queued and delivered to the next call", async () => {
    const result = await runWith(
      Effect.gen(function* () {
        const signal = yield* TunnelSignal;
        yield* signal.push("m-2", { type: "session_terminate", sessionId: "s-2" });
        return yield* signal.next("m-2");
      }),
    );
    expect(result).toEqual({ type: "session_terminate", sessionId: "s-2" });
  });

  test("queued signals are delivered in FIFO order", async () => {
    const result = await runWith(
      Effect.gen(function* () {
        const signal = yield* TunnelSignal;
        yield* signal.push("m-3", { type: "session_waiting", sessionId: "first" });
        yield* signal.push("m-3", { type: "session_waiting", sessionId: "second" });
        const a = yield* signal.next("m-3");
        const b = yield* signal.next("m-3");
        return [a, b];
      }),
    );
    expect(result).toEqual([
      { type: "session_waiting", sessionId: "first" },
      { type: "session_waiting", sessionId: "second" },
    ]);
  });

  test("a long poll with nothing to deliver times out to null rather than hanging forever", async () => {
    // The service's own long-poll timeout is 25s (TUNNEL_SIGNAL_LONG_POLL_TIMEOUT) — far
    // too slow for a unit test. Racing it against a short `Effect.timeout` here proves
    // it doesn't resolve early with some default/garbage value in that window; a real
    // regression that makes `next` resolve immediately (e.g. with `null`) would fail this
    // test by resolving before the outer timeout fires.
    const result = await runWith(
      Effect.gen(function* () {
        const signal = yield* TunnelSignal;
        return yield* signal.next("m-never-pushed");
      }).pipe(Effect.timeout("500 millis"), Effect.either),
    );
    expect(Either.isLeft(result)).toBe(true);
  }, 2_000);

  test("signals for different machines never cross-deliver", async () => {
    const result = await runWith(
      Effect.gen(function* () {
        const signal = yield* TunnelSignal;
        const forB = yield* Effect.fork(
          signal.next("machine-b").pipe(Effect.timeout("300 millis"), Effect.either),
        );
        yield* signal.push("machine-a", { type: "session_waiting", sessionId: "a-1" });
        const forA = yield* signal.next("machine-a");
        const forBResult = yield* Fiber.join(forB);
        return { forA, forBTimedOut: Either.isLeft(forBResult) };
      }),
    );
    expect(result.forA).toEqual({ type: "session_waiting", sessionId: "a-1" });
    expect(result.forBTimedOut).toBe(true);
  });

  test("a stale parked waiter that already timed out does not receive a later push meant for a fresh call", async () => {
    // Regression guard for the cleanup path in `next`'s timeout branch: after a waiter
    // times out, it must be removed from the machine's waiter list — otherwise a later
    // `push` could resolve an already-abandoned `Deferred` instead of queuing for the
    // next real caller.
    const result = await runWith(
      Effect.gen(function* () {
        const signal = yield* TunnelSignal;
        const first = yield* Effect.fork(
          signal.next("m-4").pipe(Effect.timeout("100 millis"), Effect.either),
        );
        const firstResult = yield* Fiber.join(first);
        expect(Either.isLeft(firstResult)).toBe(true);

        yield* signal.push("m-4", { type: "session_waiting", sessionId: "later" });
        return yield* signal.next("m-4");
      }),
    );
    expect(result).toEqual({ type: "session_waiting", sessionId: "later" });
  });

  test("a push resolves exactly one of several waiters parked for the same machine", async () => {
    // Regression guard for `push`'s retry loop (see signal.ts's header comment on the
    // interrupted/timed-out-waiter data-loss race a prior review pass found): with two
    // waiters parked, a single push must deliver to exactly one of them, never both and
    // never neither.
    const result = await runWith(
      Effect.gen(function* () {
        const signal = yield* TunnelSignal;
        const a = yield* Effect.fork(signal.next("m-multi"));
        const b = yield* Effect.fork(signal.next("m-multi"));
        yield* Effect.sleep(20); // let both actually register as waiters before pushing
        yield* signal.push("m-multi", { type: "session_waiting", sessionId: "only-one" });

        const aOutcome = yield* Fiber.join(a).pipe(Effect.timeout("300 millis"), Effect.either);
        const bOutcome = yield* Fiber.join(b).pipe(Effect.timeout("300 millis"), Effect.either);
        return { aOutcome, bOutcome };
      }),
    );

    const values = [result.aOutcome, result.bOutcome]
      .filter(Either.isRight)
      .map((outcome) => outcome.right)
      .filter((value) => value !== null);
    expect(values).toHaveLength(1);
    expect(values[0]).toEqual({ type: "session_waiting", sessionId: "only-one" });
  });

  test("interrupting a parked long poll (the caller's connection dropping) still cleans up its waiter", async () => {
    // Distinct from the timeout-based regression test above: here the fiber is killed
    // directly (`Fiber.interrupt`), simulating the real scenario `Effect.ensuring` in
    // `next` exists for — an HTTP long poll whose underlying connection drops mid-wait
    // (agent crash, network loss), never reaching `timeoutTo`'s own onTimeout branch at
    // all. Without the fix, the interrupted call's `Deferred` stays registered and a
    // later push resolves it into the void instead of reaching the next real caller.
    const result = await runWith(
      Effect.gen(function* () {
        const signal = yield* TunnelSignal;
        const parked = yield* Effect.fork(signal.next("m-5"));
        yield* Effect.sleep(20); // let it actually park before killing it
        yield* Fiber.interrupt(parked);

        yield* signal.push("m-5", { type: "session_waiting", sessionId: "for-next-caller" });
        return yield* signal.next("m-5");
      }),
    );
    expect(result).toEqual({ type: "session_waiting", sessionId: "for-next-caller" });
  });
});
