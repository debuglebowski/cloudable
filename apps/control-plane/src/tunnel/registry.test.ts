import { describe, expect, test } from "bun:test";
import type { TunnelFrame } from "@cloudable/contracts";
import { Effect } from "effect";
import { TunnelRegistry, type TunnelSocket } from "./registry";

/** A fake `TunnelSocket` that records everything sent to it and whether it was closed —
 * this registry's own logic is transport-agnostic specifically so it can be tested this way,
 * without a real websocket. */
function fakeSocket() {
  const sent: TunnelFrame[] = [];
  let closed = false;
  const socket: TunnelSocket = {
    send: (frame) =>
      Effect.sync(() => {
        sent.push(frame);
      }),
    close: () =>
      Effect.sync(() => {
        closed = true;
      }),
  };
  return { socket, sent, isClosed: () => closed };
}

const run = <A, E>(effect: Effect.Effect<A, E, TunnelRegistry>) =>
  Effect.runPromise(Effect.provide(effect, TunnelRegistry.Default));

describe("TunnelRegistry", () => {
  test("registerDaemon + getDaemon round-trips the same socket", async () => {
    const daemon = fakeSocket();
    const found = await run(
      Effect.gen(function* () {
        const registry = yield* TunnelRegistry;
        yield* registry.registerDaemon("machine-1", daemon.socket);
        return yield* registry.getDaemon("machine-1");
      }),
    );
    expect(found).toBe(daemon.socket);
  });

  test("getDaemon returns undefined for a machine with no connected daemon", async () => {
    const found = await run(
      Effect.gen(function* () {
        const registry = yield* TunnelRegistry;
        return yield* registry.getDaemon("no-such-machine");
      }),
    );
    expect(found).toBeUndefined();
  });

  test("getBrowser round-trips the registered browser socket for a live relay", async () => {
    const browser = fakeSocket();
    const found = await run(
      Effect.gen(function* () {
        const registry = yield* TunnelRegistry;
        yield* registry.registerRelay("session-1", "machine-1", browser.socket);
        return yield* registry.getBrowser("session-1");
      }),
    );
    expect(found).toBe(browser.socket);
  });

  test("getBrowser returns undefined for a sessionId with no live relay", async () => {
    const found = await run(
      Effect.gen(function* () {
        const registry = yield* TunnelRegistry;
        return yield* registry.getBrowser("no-such-session");
      }),
    );
    expect(found).toBeUndefined();
  });

  test("a second registerDaemon for the same machine closes the stale socket", async () => {
    const first = fakeSocket();
    const second = fakeSocket();
    const found = await run(
      Effect.gen(function* () {
        const registry = yield* TunnelRegistry;
        yield* registry.registerDaemon("machine-1", first.socket);
        yield* registry.registerDaemon("machine-1", second.socket);
        return yield* registry.getDaemon("machine-1");
      }),
    );
    expect(found).toBe(second.socket);
    expect(first.isClosed()).toBe(true);
    expect(second.isClosed()).toBe(false);
  });

  test("closeRelay sends `close` to both the browser and the daemon leg, then forgets the relay", async () => {
    const daemon = fakeSocket();
    const browser = fakeSocket();
    await run(
      Effect.gen(function* () {
        const registry = yield* TunnelRegistry;
        yield* registry.registerDaemon("machine-1", daemon.socket);
        yield* registry.registerRelay("session-1", "machine-1", browser.socket);
        yield* registry.closeRelay("session-1", "person_ended");
      }),
    );

    expect(browser.isClosed()).toBe(true);
    expect(browser.sent).toEqual([
      { kind: "close", sessionId: "session-1", reason: "person_ended" },
    ]);
    expect(daemon.sent).toEqual([
      { kind: "close", sessionId: "session-1", reason: "person_ended" },
    ]);
    // The daemon's own connection is NOT closed — it may be carrying other sessions.
    expect(daemon.isClosed()).toBe(false);
  });

  test("closeRelay on an unknown sessionId is a silent no-op", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const registry = yield* TunnelRegistry;
          yield* registry.closeRelay("no-such-session", "person_ended");
        }),
      ),
    ).resolves.toBeUndefined();
  });

  test("closeAllForMachine ends every session on that machine and leaves other machines' sessions untouched", async () => {
    const daemonA = fakeSocket();
    const browserA1 = fakeSocket();
    const browserA2 = fakeSocket();
    const browserB = fakeSocket();

    await run(
      Effect.gen(function* () {
        const registry = yield* TunnelRegistry;
        yield* registry.registerDaemon("machine-a", daemonA.socket);
        yield* registry.registerRelay("session-a1", "machine-a", browserA1.socket);
        yield* registry.registerRelay("session-a2", "machine-a", browserA2.socket);
        yield* registry.registerRelay("session-b", "machine-b", browserB.socket);
        yield* registry.closeAllForMachine("machine-a", "policy_terminated");
      }),
    );

    expect(browserA1.isClosed()).toBe(true);
    expect(browserA2.isClosed()).toBe(true);
    expect(browserB.isClosed()).toBe(false);
  });

  test("deregisterDaemon ends every live session on that machine with reason connection_lost", async () => {
    const daemon = fakeSocket();
    const browser = fakeSocket();

    await run(
      Effect.gen(function* () {
        const registry = yield* TunnelRegistry;
        yield* registry.registerDaemon("machine-1", daemon.socket);
        yield* registry.registerRelay("session-1", "machine-1", browser.socket);
        yield* registry.deregisterDaemon("machine-1");
      }),
    );

    expect(browser.isClosed()).toBe(true);
    expect(browser.sent).toEqual([
      { kind: "close", sessionId: "session-1", reason: "connection_lost" },
    ]);
  });

  test("beginHandshake + resolveHandshake: the awaited Deferred resolves with the given outcome", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const registry = yield* TunnelRegistry;
        const deferred = yield* registry.beginHandshake("session-1");
        yield* registry.resolveHandshake("session-1", { ok: true });
        return yield* deferred;
      }),
    );
    expect(outcome).toEqual({ ok: true });
  });

  test("resolveHandshake carries a rejection reason through to the awaiter", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const registry = yield* TunnelRegistry;
        const deferred = yield* registry.beginHandshake("session-1");
        yield* registry.resolveHandshake("session-1", { ok: false, reason: "invalid_signature" });
        return yield* deferred;
      }),
    );
    expect(outcome).toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("resolveHandshake for a sessionId with no pending handshake is a silent no-op", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const registry = yield* TunnelRegistry;
          yield* registry.resolveHandshake("no-such-session", { ok: true });
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
