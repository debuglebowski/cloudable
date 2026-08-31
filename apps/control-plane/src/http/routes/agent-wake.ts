import type { WakeMessage } from "@cloudable/contracts";
import { HttpApiBuilder, HttpServerRequest, HttpServerResponse, Socket } from "@effect/platform";
import { Effect } from "effect";
import { AgentSessionToken } from "../../services/attestation/AgentSessionToken";
import { MachineDirectory } from "../../services/attestation/MachineDirectory";

export type { WakeMessage } from "@cloudable/contracts";

/**
 * `wake`: the fourth agent-protocol operation (spec §23) — an optional,
 * control-plane-to-agent fast path so a machine doesn't sit out its full
 * poll interval when there's fresh desired state. Exactly one message, no
 * payload, and it cannot carry instructions (spec §8.1): the agent still
 * has to poll to find out *what* changed.
 *
 * Not an `HttpApiEndpoint` — `HttpApiEndpoint`/`HttpApiGroup` model HTTP
 * verbs, not a websocket upgrade — so this is mounted directly on the
 * shared router (`HttpApiBuilder.Router`, the same `HttpRouter` instance
 * `HttpApiBuilder.serve()` eventually turns into the one running `HttpApp`)
 * rather than added to `AgentProtocolGroup`. `@effect/platform-bun`'s
 * `HttpServerRequest.upgrade` getter does the actual upgrade against the
 * same `Bun.serve` instance the rest of the API runs on — no second port,
 * no raw `Bun.serve({websocket})` needed alongside the Effect router.
 *
 * Bearer-authenticated the same way as `/poll`/`/report` (see
 * `../handlers/agent-protocol.ts`), but only once, at the upgrade — this
 * channel never carries another message from the agent to re-verify
 * against, and it is one-way, CP → agent only (invariant #7: the agent
 * dials out; the control plane only ever sends on a connection the agent
 * already opened, never re-dials one itself).
 */

const BEARER_PREFIX = "Bearer ";

const bearerToken = (authorization: string | undefined): string | undefined =>
  authorization?.startsWith(BEARER_PREFIX) ? authorization.slice(BEARER_PREFIX.length) : undefined;

/** The one message this channel ever sends — see the file comment. */
const PULL_NOW: WakeMessage = { type: "pull_now" };
const PULL_NOW_TEXT = JSON.stringify(PULL_NOW);

type Write = (chunk: string | Socket.CloseEvent) => Effect.Effect<void, Socket.SocketError>;

/**
 * One outbound-opened websocket per attested machine, keyed by
 * `machineId`. In-memory and per-process, like `AgentSessionToken`'s
 * signing secret and `agent-protocol.ts`'s `lastObserved` diff cache — a
 * deploy or a second control-plane replica simply means that machine's
 * next `wake` has nothing to reach until it reconnects, which is exactly
 * the same "an unreachable machine just waits out its poll interval"
 * fallback the spec already treats this whole channel as optional against.
 */
export class WakeRegistry extends Effect.Service<WakeRegistry>()("WakeRegistry", {
  effect: Effect.sync(() => {
    const sockets = new Map<string, Write>();

    /**
     * Replaces any previous socket for this machine (e.g. a reconnect) rather than rejecting
     * it — and actively closes the displaced one rather than just dropping its reference, so
     * its own route fiber (blocked in `wakeHttpApp`'s `socket.runRaw`) observes the close and
     * unregisters itself promptly instead of sitting parked until the OS eventually notices
     * that connection is dead.
     */
    const register = (machineId: string, write: Write): Effect.Effect<void> =>
      Effect.gen(function* () {
        const previous = sockets.get(machineId);
        sockets.set(machineId, write);
        if (previous && previous !== write) {
          yield* previous(new Socket.CloseEvent(1000, "replaced by a newer connection")).pipe(
            Effect.catchAll(() => Effect.void),
          );
        }
      });

    /** No-ops if `write` is no longer the current socket for `machineId` (already replaced). */
    const unregister = (machineId: string, write: Write): Effect.Effect<void> =>
      Effect.sync(() => {
        if (sockets.get(machineId) === write) sockets.delete(machineId);
      });

    /**
     * Sends the one wake message if `machineId` has an open socket.
     * Returns whether one was found — never fails: a write error against a
     * socket that's already gone stale is exactly the "nothing to reach"
     * case, not a caller-facing failure.
     */
    const wake = (machineId: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const write = sockets.get(machineId);
        if (!write) return false;
        yield* write(PULL_NOW_TEXT).pipe(Effect.catchAll(() => Effect.void));
        return true;
      });

    return { register, unregister, wake } as const;
  }),
}) {}

/**
 * `GET /api/v1/agent/wake` — accepts the upgrade for an already-attested
 * machine, registers its socket, then blocks (this route's fiber, not the
 * server) until the connection closes, at which point it unregisters.
 * Never reads anything the agent sends — this channel is CP → agent only —
 * but still runs the (no-op) read loop so a close is actually observed
 * instead of leaking a dead entry in `WakeRegistry` forever.
 */
const wakeHttpApp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessions = yield* AgentSessionToken;
  const directory = yield* MachineDirectory;
  const registry = yield* WakeRegistry;

  const token = bearerToken(request.headers.authorization);
  if (!token) {
    return HttpServerResponse.unsafeJson({ reason: "missing_bearer_token" }, { status: 401 });
  }

  const identity = yield* sessions.verify(token).pipe(Effect.either);
  if (identity._tag === "Left") {
    return HttpServerResponse.unsafeJson({ reason: identity.left.reason }, { status: 401 });
  }

  const machine = yield* directory.findById(identity.right.machineId);
  if (!machine || machine.orgId !== identity.right.orgId) {
    return HttpServerResponse.unsafeJson({ reason: "machine_not_found" }, { status: 401 });
  }

  const upgraded = yield* request.upgrade.pipe(Effect.either);
  if (upgraded._tag === "Left") {
    return HttpServerResponse.text("expected a websocket upgrade", { status: 400 });
  }
  const socket = upgraded.right;
  const write = yield* socket.writer;

  yield* registry.register(machine.id, write);
  // Blocks until the socket closes, for whatever reason — that's the only signal this route
  // needs to know it's time to clean up; nothing the agent could send here would ever matter.
  yield* socket.runRaw(() => Effect.void).pipe(Effect.catchAll(() => Effect.void));
  yield* registry.unregister(machine.id, write);

  return HttpServerResponse.empty();
});

export const AgentWakeRouteLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    // `HttpApiBuilder.Router`'s own `R` is fixed at `never` (it only ever promises
    // `Provided` — request/scope/params — to a mounted handler's static type), the same
    // reason `HttpApiBuilder.group` resolves its handlers' extra context up front rather
    // than leaving it as a handler-level requirement (see that function's own `as any` —
    // this mirrors it, minus the cast, by resolving the services this route needs against
    // whatever's ambient when this layer is built, instead of asserting past the checker).
    const context = yield* Effect.context<AgentSessionToken | MachineDirectory | WakeRegistry>();
    yield* router.get("/api/v1/agent/wake", Effect.provide(wakeHttpApp, context));
  }),
);
