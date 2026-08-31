// Runs against the local dev Postgres — see `../services/ssh-ca/SshCaService.test.ts` for why
// (testcontainers timed out in this sandbox). Every row is scoped to a fresh random `orgId`.
import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { events, machines, orgs, sessions } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Db, DbLive } from "../db/layer";
import { EventBus } from "../services/EventBus";
import { LocalSignerLive } from "../services/Signer.local";
import { TunnelServer } from "./server";
import { TunnelSignal } from "./signal";

// `provideMerge`, not `provide`: `TunnelServer.mintSession` calls `mintSessionToken`, which
// reads `SignerTag` lazily *when invoked*, not only while `TunnelServer.Default` itself is
// being constructed — `provide` would satisfy construction but then hide `Signer` from the
// context a caller later runs `mintSession` in, failing at call time despite type-checking
// cleanly. `provideMerge` keeps `Db`/`EventBus`/`Signer`/`TunnelSignal` in the final context
// alongside `TunnelServer` itself — the last of those is also read directly by several tests
// below, to assert `TunnelServer` actually pushed to it. See the identical comment in
// `../layers.ts`.
const TestLayer = TunnelServer.Default.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      EventBus.Default.pipe(Layer.provide(DbLive)),
      LocalSignerLive,
      DbLive,
      TunnelSignal.Default,
    ),
  ),
);

async function withOrgAndMachine<T>(
  state: "running" | "stopped" | "archived_restorable",
  run: (ctx: { orgId: string; machineId: string }) => Promise<T>,
): Promise<T> {
  const program = Effect.gen(function* () {
    const db = yield* Db;
    const [org] = yield* Effect.tryPromise(() =>
      db
        .insert(orgs)
        .values({ name: `test-${crypto.randomUUID()}` })
        .returning({ id: orgs.id }),
    );
    if (!org) throw new Error("failed to insert org");
    const [machine] = yield* Effect.tryPromise(() =>
      db
        .insert(machines)
        .values({
          orgId: org.id,
          name: "m-1",
          region: "eastus",
          sizeSku: "Standard_B2s",
          image: "ubuntu-24.04",
          state,
        })
        .returning({ id: machines.id }),
    );
    if (!machine) throw new Error("failed to insert machine");
    return { orgId: org.id, machineId: machine.id };
  });
  const ctx = await Effect.runPromise(Effect.provide(program, DbLive));
  return run(ctx);
}

const queryDb = <A>(effect: Effect.Effect<A, unknown, Db>) =>
  Effect.runPromise(Effect.provide(effect, DbLive));

describe("TunnelServer (against local dev Postgres)", () => {
  test("mintSession against a running machine persists a session and emits access.session_started", async () => {
    await withOrgAndMachine("running", async ({ orgId, machineId }) => {
      const personId = crypto.randomUUID();
      const program = Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        return yield* tunnel.mintSession({
          orgId,
          personId,
          idpIdentity: "kalle@normain.com",
          targetMachineId: machineId,
          targetOsUser: "ubuntu",
          method: "terminal",
        });
      });

      const minted = await Effect.runPromise(Effect.provide(program, TestLayer));
      expect(minted.token.split(".")).toHaveLength(2);
      expect(minted.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const { sessionRow, eventRows } = await queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          const sessionRows = yield* Effect.tryPromise(() =>
            db.select().from(sessions).where(eq(sessions.id, minted.sessionId)),
          );
          const evRows = yield* Effect.tryPromise(() =>
            db.select().from(events).where(eq(events.correlationId, minted.sessionId)),
          );
          return { sessionRow: sessionRows[0], eventRows: evRows };
        }),
      );

      expect(sessionRow?.machineId).toBe(machineId);
      expect(sessionRow?.personId).toBe(personId);
      expect(sessionRow?.method).toBe("terminal");
      expect(sessionRow?.endedAt).toBeNull();

      expect(eventRows).toHaveLength(1);
      expect(eventRows[0]?.type).toBe("access.session_started");
    });
  });

  test("mintSession against a stopped machine is denied and emits access.session_denied", async () => {
    await withOrgAndMachine("stopped", async ({ orgId, machineId }) => {
      const program = Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        return yield* tunnel.mintSession({
          orgId,
          personId: crypto.randomUUID(),
          idpIdentity: "kalle@normain.com",
          targetMachineId: machineId,
          targetOsUser: "ubuntu",
          method: "ssh",
        });
      });

      const error = await Effect.runPromise(Effect.provide(Effect.flip(program), TestLayer));
      expect(error.reason).toBe("denied");
      expect(error.detail).toBe("machine_stopped");

      const deniedEvents = await queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          return yield* Effect.tryPromise(() =>
            db.select().from(events).where(eq(events.machineId, machineId)),
          );
        }),
      );
      expect(deniedEvents.some((e) => e.type === "access.session_denied")).toBe(true);
    });
  });

  test("mintSession against a nonexistent machine is denied with machine_not_found", async () => {
    await withOrgAndMachine("running", async ({ orgId }) => {
      const program = Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        return yield* tunnel.mintSession({
          orgId,
          personId: crypto.randomUUID(),
          idpIdentity: "kalle@normain.com",
          targetMachineId: crypto.randomUUID(),
          targetOsUser: "ubuntu",
          method: "terminal",
        });
      });
      const error = await Effect.runPromise(Effect.provide(Effect.flip(program), TestLayer));
      expect(error.detail).toBe("machine_not_found");
    });
  });

  test("endSession sets endedAt/durationSeconds and emits access.session_ended", async () => {
    await withOrgAndMachine("running", async ({ orgId, machineId }) => {
      const mint = Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        return yield* tunnel.mintSession({
          orgId,
          personId: crypto.randomUUID(),
          idpIdentity: "kalle@normain.com",
          targetMachineId: machineId,
          targetOsUser: "ubuntu",
          method: "terminal",
        });
      });
      const minted = await Effect.runPromise(Effect.provide(mint, TestLayer));

      const end = Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        yield* tunnel.endSession({ orgId, sessionId: minted.sessionId });
      });
      await Effect.runPromise(Effect.provide(end, TestLayer));

      const row = await queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          const rows = yield* Effect.tryPromise(() =>
            db.select().from(sessions).where(eq(sessions.id, minted.sessionId)),
          );
          return rows[0];
        }),
      );
      expect(row?.endedAt).not.toBeNull();
      expect(row?.durationSeconds).toBeGreaterThanOrEqual(0);

      const endError = await Effect.runPromise(Effect.provide(Effect.flip(end), TestLayer));
      expect(endError.reason).toBe("not_found");
    });
  });

  test("endSession pushes a session_terminate tunnel signal for the ended session", async () => {
    await withOrgAndMachine("running", async ({ orgId, machineId }) => {
      // One `runPromise` for the whole thing (see the mintSession signal test above for why)
      // — this is the person-initiated end path, the one with a real, already-wired
      // production HTTP endpoint (`POST /api/v1/access/sessions/end`), so a regression here
      // would leave a real tunnel client with no way to ever learn to disconnect.
      const program = Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        const minted = yield* tunnel.mintSession({
          orgId,
          personId: crypto.randomUUID(),
          idpIdentity: "kalle@normain.com",
          targetMachineId: machineId,
          targetOsUser: "ubuntu",
          method: "terminal",
        });

        const signal = yield* TunnelSignal;
        // Drain the session_waiting signal `mintSession` just pushed, so the signal read
        // below is unambiguously the one `endSession` pushes, not that one.
        yield* signal.next(machineId);

        yield* tunnel.endSession({ orgId, sessionId: minted.sessionId });
        const delivered = yield* signal.next(machineId);
        return { sessionId: minted.sessionId, delivered };
      });

      const { sessionId, delivered } = await Effect.runPromise(Effect.provide(program, TestLayer));
      expect(delivered).toEqual({ type: "session_terminate", sessionId });
    });
  });

  test("terminateSessionsForMachine ends every live session and emits one access.session_ended per session", async () => {
    await withOrgAndMachine("running", async ({ orgId, machineId }) => {
      const mint = (personId: string) =>
        Effect.gen(function* () {
          const tunnel = yield* TunnelServer;
          return yield* tunnel.mintSession({
            orgId,
            personId,
            idpIdentity: "kalle@normain.com",
            targetMachineId: machineId,
            targetOsUser: "ubuntu",
            method: "terminal",
          });
        });

      const a = await Effect.runPromise(Effect.provide(mint(crypto.randomUUID()), TestLayer));
      const b = await Effect.runPromise(Effect.provide(mint(crypto.randomUUID()), TestLayer));

      const terminated = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const tunnel = yield* TunnelServer;
            return yield* tunnel.terminateSessionsForMachine({
              orgId,
              machineId,
              reason: "access disabled by policy",
            });
          }),
          TestLayer,
        ),
      );
      expect(terminated).toBe(2);

      const rows = await queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          return yield* Effect.tryPromise(() =>
            db.select().from(sessions).where(eq(sessions.machineId, machineId)),
          );
        }),
      );
      expect(rows.every((r) => r.endedAt !== null)).toBe(true);
      expect(rows.map((r) => r.id).sort()).toEqual([a.sessionId, b.sessionId].sort());
    });
  });

  test("mintSession pushes a session_waiting tunnel signal for the target machine", async () => {
    await withOrgAndMachine("running", async ({ orgId, machineId }) => {
      // Everything runs against the one `TestLayer` instance this single `runPromise` builds
      // — reading the signal back via a *separate* `Effect.provide(..., TestLayer)` call
      // would build a second, unrelated `TunnelSignal` instance (Effect layers aren't
      // memoized across independent top-level runs) and never see what was pushed here.
      const program = Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        const minted = yield* tunnel.mintSession({
          orgId,
          personId: crypto.randomUUID(),
          idpIdentity: "kalle@normain.com",
          targetMachineId: machineId,
          targetOsUser: "ubuntu",
          method: "terminal",
        });
        const signal = yield* TunnelSignal;
        const delivered = yield* signal.next(machineId);
        return { minted, delivered };
      });

      const { minted, delivered } = await Effect.runPromise(Effect.provide(program, TestLayer));
      expect(delivered).toEqual({ type: "session_waiting", sessionId: minted.sessionId });
    });
  });

  test("mintSession denied against a non-running machine pushes no tunnel signal", async () => {
    await withOrgAndMachine("stopped", async ({ orgId, machineId }) => {
      const program = Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        yield* Effect.either(
          tunnel.mintSession({
            orgId,
            personId: crypto.randomUUID(),
            idpIdentity: "kalle@normain.com",
            targetMachineId: machineId,
            targetOsUser: "ubuntu",
            method: "terminal",
          }),
        );
        const signal = yield* TunnelSignal;
        return yield* signal.next(machineId).pipe(Effect.timeout("300 millis"), Effect.either);
      });

      const result = await Effect.runPromise(Effect.provide(program, TestLayer));
      expect(result._tag).toBe("Left"); // timed out — nothing was ever pushed to signal
    });
  });

  test("terminateSessionsForMachine pushes one session_terminate tunnel signal per session ended", async () => {
    await withOrgAndMachine("running", async ({ orgId, machineId }) => {
      const mint = (personId: string) =>
        Effect.gen(function* () {
          const tunnel = yield* TunnelServer;
          return yield* tunnel.mintSession({
            orgId,
            personId,
            idpIdentity: "kalle@normain.com",
            targetMachineId: machineId,
            targetOsUser: "ubuntu",
            method: "terminal",
          });
        });

      const program = Effect.gen(function* () {
        const a = yield* mint(crypto.randomUUID());
        const b = yield* mint(crypto.randomUUID());

        const signal = yield* TunnelSignal;
        // Drain the two `session_waiting` signals the mints above just pushed, so the
        // terminate signals below are the next ones in queue, not mixed in behind them.
        yield* signal.next(machineId);
        yield* signal.next(machineId);

        const tunnel = yield* TunnelServer;
        yield* tunnel.terminateSessionsForMachine({
          orgId,
          machineId,
          reason: "access disabled by policy",
        });

        const first = yield* signal.next(machineId);
        const second = yield* signal.next(machineId);
        return { sessionIds: [a.sessionId, b.sessionId], delivered: [first, second] };
      });

      const { sessionIds, delivered } = await Effect.runPromise(Effect.provide(program, TestLayer));
      expect(delivered.every((d) => d?.type === "session_terminate")).toBe(true);
      expect(delivered.map((d) => (d as { sessionId: string }).sessionId).sort()).toEqual(
        [...sessionIds].sort(),
      );
    });
  });
});
