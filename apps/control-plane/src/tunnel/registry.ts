// ---------------------------------------------------------------------------
// In-process registry of live tunnel connections (spec §8.2/§11.1). This is
// the piece that closes the exact gap an earlier audit of this codebase
// found: `TunnelServer.endSession`/`terminateSessionsForMachine` (unmodified
// by this file) only ever touch the `sessions` DB row — nothing before this
// registry existed closed the actual live browser<->daemon connection. See
// `tunnel/relay.ts` (composes this registry with `TunnelServer`) and
// `http/handlers/tunnel.ts` (the real websocket routes that register/read
// from this registry) — neither exists yet; this file is deliberately
// transport-agnostic (`TunnelSocket` below, not `@effect/platform`'s
// `Socket.Socket` directly) so it's unit-testable without a real network
// connection and without depending on code that doesn't exist yet.
//
// Not persisted (deliberately, for now): a horizontally-scaled control
// plane would need this shared across instances (e.g. via pub/sub) for a
// browser connecting to instance A to reach a daemon connected to instance
// B. Out of scope for this build's single-instance deployment model — see
// the approved web-terminal plan's "Open risks" section.
// ---------------------------------------------------------------------------
import type { TunnelFrame } from "@cloudable/contracts";
import { Deferred, Effect, Ref } from "effect";

/**
 * A live connection this registry can push frames to and tear down — an
 * abstraction over the real websocket (`Socket.Socket`, wired up in
 * `http/handlers/tunnel.ts`) so this registry's own logic never touches a
 * transport directly.
 */
export interface TunnelSocket {
  send(frame: TunnelFrame): Effect.Effect<void>;
  close(): Effect.Effect<void>;
}

export type AttachOutcome = { ok: true } | { ok: false; reason: string };

interface RelayEntry {
  readonly machineId: string;
  readonly browserSocket: TunnelSocket;
}

export class TunnelRegistry extends Effect.Service<TunnelRegistry>()("TunnelRegistry", {
  effect: Effect.gen(function* () {
    /** One connected daemon socket per machine — a machine has at most one live tunnel
     * daemon connection at a time. */
    const daemons = yield* Ref.make(new Map<string, TunnelSocket>());
    /** One entry per live session, keyed by `sessionId` — the join between a browser leg and
     * the daemon connection carrying it (looked up by `machineId` in `daemons`). */
    const relays = yield* Ref.make(new Map<string, RelayEntry>());
    /** In-flight `attach` handshakes: a browser leg has sent `attach` to the daemon and is
     * waiting for `attached`/`attach_rejected` to come back over the daemon's socket. Resolved
     * by whichever code reads inbound frames off that socket (`http/handlers/tunnel.ts`'s
     * daemon-connect route); awaited by the browser-attach route. */
    const pendingHandshakes = yield* Ref.make(new Map<string, Deferred.Deferred<AttachOutcome>>());

    /**
     * Registers a newly-connected daemon for `machineId`. A second daemon connecting for the
     * same machine (reconnect after a network blip, or a misconfigured duplicate) replaces the
     * old socket outright — closing the stale one, rather than leaving two both believing
     * they're "the" connection for that machine.
     */
    const registerDaemon = (machineId: string, socket: TunnelSocket): Effect.Effect<void> =>
      Effect.gen(function* () {
        const previous = yield* Ref.modify(daemons, (map) => {
          const existing = map.get(machineId);
          const next = new Map(map);
          next.set(machineId, socket);
          return [existing, next];
        });
        if (previous) yield* previous.close();
      });

    /**
     * Deregisters a machine's daemon connection (it dropped) and ends every live session it
     * was carrying — a dropped daemon connection means every session on that machine is
     * already dead, not merely unreachable, so their browser legs are told so immediately
     * rather than left hanging until they time out on their own.
     */
    const deregisterDaemon = (machineId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(daemons, (map) => {
          const next = new Map(map);
          next.delete(machineId);
          return next;
        });
        yield* closeAllForMachine(machineId, "connection_lost");
      });

    const getDaemon = (machineId: string): Effect.Effect<TunnelSocket | undefined> =>
      Ref.get(daemons).pipe(Effect.map((map) => map.get(machineId)));

    const registerRelay = (
      sessionId: string,
      machineId: string,
      browserSocket: TunnelSocket,
    ): Effect.Effect<void> =>
      Ref.update(relays, (map) => {
        const next = new Map(map);
        next.set(sessionId, { machineId, browserSocket });
        return next;
      });

    const deregisterRelay = (sessionId: string): Effect.Effect<void> =>
      Ref.update(relays, (map) => {
        const next = new Map(map);
        next.delete(sessionId);
        return next;
      });

    /** The browser leg for a live session, if any — used by the daemon-connect route
     * (`http/handlers/tunnel.ts`) to forward the daemon's own inbound `data`/`close` frames
     * for this session to the matching browser socket. */
    const getBrowser = (sessionId: string): Effect.Effect<TunnelSocket | undefined> =>
      Ref.get(relays).pipe(Effect.map((map) => map.get(sessionId)?.browserSocket));

    /**
     * Registers a pending `attach` handshake and returns the `Deferred` the caller should
     * await. Overwrites (rather than errors on) a pre-existing entry for the same
     * `sessionId` — a re-attach after a dropped websocket is expected, not a bug.
     */
    const beginHandshake = (sessionId: string): Effect.Effect<Deferred.Deferred<AttachOutcome>> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<AttachOutcome>();
        yield* Ref.update(pendingHandshakes, (map) => {
          const next = new Map(map);
          next.set(sessionId, deferred);
          return next;
        });
        return deferred;
      });

    /**
     * Resolves a pending handshake (called when `attached`/`attach_rejected` arrives on the
     * daemon socket). A silent no-op if there's no pending handshake for this `sessionId` —
     * a late or duplicate frame after the browser side already gave up and timed out is not
     * an error condition.
     */
    const resolveHandshake = (sessionId: string, outcome: AttachOutcome): Effect.Effect<void> =>
      Effect.gen(function* () {
        const deferred = yield* Ref.modify(pendingHandshakes, (map) => {
          const existing = map.get(sessionId);
          if (!existing) return [undefined, map];
          const next = new Map(map);
          next.delete(sessionId);
          return [existing, next];
        });
        if (deferred) yield* Deferred.succeed(deferred, outcome);
      });

    /**
     * Ends one live session: tells the browser leg to close (and closes its socket), tells
     * the daemon leg (if still connected) to close that one session — NOT the whole daemon
     * connection, which may be carrying other sessions — then forgets the relay entry.
     */
    const closeRelay = (sessionId: string, reason: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entry = yield* Ref.get(relays).pipe(Effect.map((map) => map.get(sessionId)));
        if (!entry) return;

        yield* entry.browserSocket.send({ kind: "close", sessionId, reason });
        yield* entry.browserSocket.close();

        const daemon = yield* getDaemon(entry.machineId);
        if (daemon) yield* daemon.send({ kind: "close", sessionId, reason });

        yield* deregisterRelay(sessionId);
      });

    /** Ends every live session on `machineId` — used for policy-triggered termination (spec
     * §8.2: "must terminate live sessions on policy change") and by `deregisterDaemon` when
     * the daemon's own connection drops. */
    const closeAllForMachine = (machineId: string, reason: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const sessionIds = yield* Ref.get(relays).pipe(
          Effect.map((map) =>
            Array.from(map.entries())
              .filter(([, entry]) => entry.machineId === machineId)
              .map(([sessionId]) => sessionId),
          ),
        );
        yield* Effect.forEach(sessionIds, (sessionId) => closeRelay(sessionId, reason), {
          discard: true,
        });
      });

    return {
      registerDaemon,
      deregisterDaemon,
      getDaemon,
      registerRelay,
      deregisterRelay,
      getBrowser,
      beginHandshake,
      resolveHandshake,
      closeRelay,
      closeAllForMachine,
    } as const;
  }),
}) {}
