import { describe, expect, test } from "bun:test";
import { HttpApiBuilder, HttpServer, Socket } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { AgentSessionToken } from "../../services/attestation/AgentSessionToken";
import { MachineDirectory, type MachineRecord } from "../../services/attestation/MachineDirectory";
import { AgentWakeRouteLive, WakeRegistry } from "./agent-wake";

const PULL_NOW_TEXT = JSON.stringify({ type: "pull_now" });

describe("WakeRegistry", () => {
  test("wake returns false when no socket is registered for the machine", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(WakeRegistry, (registry) => registry.wake("no-such-machine")),
        WakeRegistry.Default,
      ),
    );
    expect(result).toBe(false);
  });

  test("wake sends exactly one pull_now text frame to the registered socket's writer", async () => {
    const sent: (string | Socket.CloseEvent)[] = [];
    const write = (chunk: string | Socket.CloseEvent) =>
      Effect.sync(() => {
        sent.push(chunk);
      });

    const program = Effect.gen(function* () {
      const registry = yield* WakeRegistry;
      const delivered = yield* registry
        .register("m-1", write)
        .pipe(Effect.zipRight(registry.wake("m-1")));
      return delivered;
    });

    const delivered = await Effect.runPromise(Effect.provide(program, WakeRegistry.Default));

    expect(delivered).toBe(true);
    expect(sent).toEqual([PULL_NOW_TEXT]);
  });

  test("unregister removes the socket so a later wake finds nothing", async () => {
    const write = () => Effect.void;

    const program = Effect.gen(function* () {
      const registry = yield* WakeRegistry;
      yield* registry.register("m-1", write);
      const before = yield* registry.wake("m-1");
      yield* registry.unregister("m-1", write);
      const after = yield* registry.wake("m-1");
      return { before, after };
    });

    const { before, after } = await Effect.runPromise(
      Effect.provide(program, WakeRegistry.Default),
    );
    expect(before).toBe(true);
    expect(after).toBe(false);
  });

  test("unregister is a no-op if a reconnect already replaced the socket for that machine", async () => {
    const stale = () => Effect.void;
    const current = () => Effect.void;

    const program = Effect.gen(function* () {
      const registry = yield* WakeRegistry;
      yield* registry.register("m-1", stale);
      yield* registry.register("m-1", current); // simulates a reconnect replacing the old socket
      yield* registry.unregister("m-1", stale); // the *old* connection's own cleanup running late
      return yield* registry.wake("m-1");
    });

    const stillReachable = await Effect.runPromise(Effect.provide(program, WakeRegistry.Default));
    expect(stillReachable).toBe(true);
  });

  test("registering a new socket for a machine closes the one it displaces", async () => {
    const staleEvents: (string | Socket.CloseEvent)[] = [];
    const stale = (chunk: string | Socket.CloseEvent) =>
      Effect.sync(() => {
        staleEvents.push(chunk);
      });
    const current = () => Effect.void;

    const program = Effect.gen(function* () {
      const registry = yield* WakeRegistry;
      yield* registry.register("m-1", stale);
      yield* registry.register("m-1", current); // a reconnect: this should close `stale`
    });

    await Effect.runPromise(Effect.provide(program, WakeRegistry.Default));

    expect(staleEvents).toHaveLength(1);
    expect(Socket.isCloseEvent(staleEvents[0])).toBe(true);
  });
});

describe("GET /api/v1/agent/wake", () => {
  const machine: MachineRecord = {
    id: "machine-1",
    orgId: "org-1",
    state: "running",
    lastVerifiedAt: null,
  };

  const FakeMachineDirectoryLive = Layer.succeed(MachineDirectory, {
    _tag: "MachineDirectory" as const,
    findById: (id: string) => Effect.succeed(id === machine.id ? machine : undefined),
    markVerified: () => Effect.void,
  });

  const SharedLive = Layer.mergeAll(
    WakeRegistry.Default,
    AgentSessionToken.Default,
    FakeMachineDirectoryLive,
  );

  // `HttpApiBuilder.Router.serve()` only asks (at the type level) for `HttpServer.HttpServer`
  // — `AgentWakeRouteLive` resolves its own `AgentSessionToken`/`MachineDirectory`/
  // `WakeRegistry` requirement up front (see agent-wake.ts) via the ambient context at build
  // time, which is exactly what the two `provideMerge`s below supply. `provideMerge` (not
  // `provide`) so `program` below can still read `HttpServer.HttpServer`/`AgentSessionToken`/
  // `WakeRegistry` itself, alongside the running server, rather than those being consumed
  // and hidden the moment they satisfy the router.
  const TestServerLive = HttpApiBuilder.Router.serve().pipe(
    Layer.provide(AgentWakeRouteLive),
    Layer.provideMerge(SharedLive),
    Layer.provideMerge(BunHttpServer.layer({ port: 0 })),
  );

  const openClientSocket = (port: number, token: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/api/v1/agent/wake`, {
        headers: { authorization: `Bearer ${token}` },
      });
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", () => reject(new Error("client socket failed to open")), {
        once: true,
      });
    });

  const nextTextMessage = (ws: WebSocket): Promise<string> =>
    new Promise((resolve) => {
      ws.addEventListener(
        "message",
        (event) => resolve(typeof event.data === "string" ? event.data : ""),
        { once: true },
      );
    });

  test("a wake sent to a connected, attested machine reaches its client socket", async () => {
    const program = Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const sessions = yield* AgentSessionToken;
      const registry = yield* WakeRegistry;

      if (server.address._tag !== "TcpAddress") {
        return yield* Effect.die(new Error("expected a TCP address from the test server"));
      }
      const { port } = server.address;
      const { token } = sessions.mint({ orgId: machine.orgId, machineId: machine.id });

      const ws = yield* Effect.promise(() => openClientSocket(port, token));
      const message = nextTextMessage(ws);

      // The route registers the socket with `WakeRegistry` a tick after the client observes
      // "open" — retry `wake()` until it actually finds a socket instead of asserting on a
      // fixed delay, bounded so a real regression fails fast rather than hanging.
      let delivered = false;
      for (let attempt = 0; attempt < 200 && !delivered; attempt++) {
        delivered = yield* registry.wake(machine.id);
        if (!delivered) yield* Effect.sleep("10 millis");
      }
      expect(delivered).toBe(true);

      const received = yield* Effect.promise(() => message);
      ws.close();
      return received;
    });

    const received = await Effect.runPromise(Effect.provide(program, TestServerLive));
    expect(received).toBe(PULL_NOW_TEXT);
  });

  test("rejects the upgrade with 401 when no bearer token is presented", async () => {
    const program = Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag !== "TcpAddress") {
        return yield* Effect.die(new Error("expected a TCP address from the test server"));
      }
      const { port } = server.address;
      const res = yield* Effect.promise(() => fetch(`http://localhost:${port}/api/v1/agent/wake`));
      return res.status;
    });

    const status = await Effect.runPromise(Effect.provide(program, TestServerLive));
    expect(status).toBe(401);
  });

  test("rejects the upgrade with 401 for a bearer token naming an unknown machine", async () => {
    const program = Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const sessions = yield* AgentSessionToken;
      if (server.address._tag !== "TcpAddress") {
        return yield* Effect.die(new Error("expected a TCP address from the test server"));
      }
      const { port } = server.address;
      const { token } = sessions.mint({ orgId: "org-1", machineId: "no-such-machine" });
      const res = yield* Effect.promise(() =>
        fetch(`http://localhost:${port}/api/v1/agent/wake`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      return res.status;
    });

    const status = await Effect.runPromise(Effect.provide(program, TestServerLive));
    expect(status).toBe(401);
  });
});
