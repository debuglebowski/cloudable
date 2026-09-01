// Runs against the local dev Postgres — same reasoning as `server.test.ts` (Testcontainers
// times out in this sandbox). `TunnelServer`'s half is real DB + events; `TunnelRegistry`'s
// half is real in-memory Ref<Map> state with fake `TunnelSocket` doubles standing in for a
// real websocket (neither `http/handlers/tunnel.ts` nor a real daemon connection exists yet).
import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import type { TunnelFrame } from "@cloudable/contracts";
import { events, elevations, machines, orgs, people, sessions } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Db, DbLive } from "../db/layer";
import { EventBus } from "../services/EventBus";
import type { SignerTag } from "../services/Signer";
import { LocalSignerLive } from "../services/Signer.local";
import { TunnelRegistry, type TunnelSocket } from "./registry";
import { TunnelRelay, closeSessionsWithLapsedAuthorization } from "./relay";
import { TunnelServer } from "./server";
import { TunnelSignal } from "./signal";

type TestContext = TunnelRelay | TunnelServer | TunnelRegistry | EventBus | SignerTag | Db;

const TestLayer = TunnelRelay.Default.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      TunnelServer.Default.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            EventBus.Default.pipe(Layer.provide(DbLive)),
            LocalSignerLive,
            DbLive,
            TunnelSignal.Default,
          ),
        ),
      ),
      TunnelRegistry.Default,
    ),
  ),
);

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

async function withOrgAndMachine<T>(
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
          state: "running",
        })
        .returning({ id: machines.id }),
    );
    if (!machine) throw new Error("failed to insert machine");
    return { orgId: org.id, machineId: machine.id };
  });
  const ctx = await Effect.runPromise(Effect.provide(program, DbLive));
  return run(ctx);
}

const run = <A, E>(effect: Effect.Effect<A, E, TestContext>) =>
  Effect.runPromise(Effect.provide(effect, TestLayer));

const queryDb = <A>(effect: Effect.Effect<A, unknown, Db>) =>
  Effect.runPromise(Effect.provide(effect, DbLive));

describe("TunnelRelay (against local dev Postgres)", () => {
  test("endSession ends the DB row AND tears down the live connection", async () => {
    await withOrgAndMachine(async ({ orgId, machineId }) => {
      const minted = await run(
        Effect.gen(function* () {
          const server = yield* TunnelServer;
          return yield* server.mintSession({
            orgId,
            personId: crypto.randomUUID(),
            idpIdentity: "kalle@normain.com",
            targetMachineId: machineId,
            targetOsUser: "ubuntu",
            method: "terminal",
          });
        }),
      );

      const browser = fakeSocket();
      // Registering the relay and ending the session must run in the SAME `run()` call —
      // `TunnelRegistry` is fresh, in-memory state constructed anew by each independent
      // `Effect.provide(..., TestLayer)` call; splitting these into separate `run()` calls
      // would register the fake socket into one `TunnelRegistry` instance and then close a
      // session against a completely different, empty one.
      await run(
        Effect.gen(function* () {
          const registry = yield* TunnelRegistry;
          yield* registry.registerRelay(minted.sessionId, machineId, browser.socket);
          const relay = yield* TunnelRelay;
          yield* relay.endSession({ orgId, sessionId: minted.sessionId, reason: "person_ended" });
        }),
      );

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
      expect(row?.terminationReason).toBe("person_ended");

      expect(browser.isClosed()).toBe(true);
      expect(browser.sent).toEqual([
        { kind: "close", sessionId: minted.sessionId, reason: "person_ended" },
      ]);
    });
  });

  test("endSession still ends the DB row when no live connection was ever registered (minted-but-unused token)", async () => {
    await withOrgAndMachine(async ({ orgId, machineId }) => {
      const minted = await run(
        Effect.gen(function* () {
          const server = yield* TunnelServer;
          return yield* server.mintSession({
            orgId,
            personId: crypto.randomUUID(),
            idpIdentity: "kalle@normain.com",
            targetMachineId: machineId,
            targetOsUser: "ubuntu",
            method: "terminal",
          });
        }),
      );

      await expect(
        run(
          Effect.gen(function* () {
            const relay = yield* TunnelRelay;
            yield* relay.endSession({ orgId, sessionId: minted.sessionId, reason: "person_ended" });
          }),
        ),
      ).resolves.toBeUndefined();

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
    });
  });

  test("terminateSessionsForMachine ends every live DB session on the machine AND every live connection", async () => {
    await withOrgAndMachine(async ({ orgId, machineId }) => {
      const mint = () =>
        run(
          Effect.gen(function* () {
            const server = yield* TunnelServer;
            return yield* server.mintSession({
              orgId,
              personId: crypto.randomUUID(),
              idpIdentity: "kalle@normain.com",
              targetMachineId: machineId,
              targetOsUser: "ubuntu",
              method: "terminal",
            });
          }),
        );
      const a = await mint();
      const b = await mint();

      const browserA = fakeSocket();
      const browserB = fakeSocket();
      // Same single-`run()` requirement as the `endSession` test above — registration and
      // termination must share one `TunnelRegistry` instance.
      const count = await run(
        Effect.gen(function* () {
          const registry = yield* TunnelRegistry;
          yield* registry.registerRelay(a.sessionId, machineId, browserA.socket);
          yield* registry.registerRelay(b.sessionId, machineId, browserB.socket);

          const relay = yield* TunnelRelay;
          return yield* relay.terminateSessionsForMachine({
            orgId,
            machineId,
            reason: "policy_terminated",
          });
        }),
      );
      expect(count).toBe(2);
      expect(browserA.isClosed()).toBe(true);
      expect(browserB.isClosed()).toBe(true);

      const rows = await queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          return yield* Effect.tryPromise(() =>
            db.select().from(sessions).where(eq(sessions.machineId, machineId)),
          );
        }),
      );
      expect(
        rows.every((r) => r.endedAt !== null && r.terminationReason === "policy_terminated"),
      ).toBe(true);
    });
  });

  test("endSession propagates TunnelServer's not_found error and never touches the registry", async () => {
    await withOrgAndMachine(async ({ orgId }) => {
      const error = await Effect.runPromise(
        Effect.provide(
          Effect.flip(
            Effect.gen(function* () {
              const relay = yield* TunnelRelay;
              yield* relay.endSession({
                orgId,
                sessionId: crypto.randomUUID(),
                reason: "person_ended",
              });
            }),
          ),
          TestLayer,
        ),
      );
      expect(error.reason).toBe("not_found");
    });
  });

  // Spec §15: mint-time authorization (access-authorization.ts) isn't enough on its own — a
  // session opened on the strength of a valid elevation must not keep running once that
  // elevation lapses. These tests seed `sessions`/`elevations` rows directly (not through
  // `TunnelServer.mintSession`) so each one exercises `closeSessionsWithLapsedAuthorization`'s
  // own logic in isolation, decoupled from the separately-tested mint-time gate it reuses.
  describe("closeSessionsWithLapsedAuthorization (against local dev Postgres)", () => {
    const seedOwnedMachineAndStranger = () =>
      queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          const [org] = yield* Effect.tryPromise(() =>
            db
              .insert(orgs)
              .values({ name: `test-${crypto.randomUUID()}` })
              .returning({ id: orgs.id }),
          );
          if (!org) throw new Error("failed to insert org");
          const [owner] = yield* Effect.tryPromise(() =>
            db
              .insert(people)
              .values({
                orgId: org.id,
                email: `${crypto.randomUUID()}@example.com`,
                role: "member",
              })
              .returning(),
          );
          if (!owner) throw new Error("failed to insert owner");
          const [stranger] = yield* Effect.tryPromise(() =>
            db
              .insert(people)
              .values({
                orgId: org.id,
                email: `${crypto.randomUUID()}@example.com`,
                role: "member",
              })
              .returning(),
          );
          if (!stranger) throw new Error("failed to insert stranger");
          const [machine] = yield* Effect.tryPromise(() =>
            db
              .insert(machines)
              .values({
                orgId: org.id,
                name: "m-1",
                region: "eastus",
                sizeSku: "Standard_B2s",
                image: "ubuntu-24.04",
                state: "running",
                ownerPersonId: owner.id,
              })
              .returning({ id: machines.id }),
          );
          if (!machine) throw new Error("failed to insert machine");
          return {
            orgId: org.id,
            machineId: machine.id,
            ownerPersonId: owner.id,
            strangerPersonId: stranger.id,
          };
        }),
      );

    const seedOpenSession = (row: { orgId: string; machineId: string; personId: string }) =>
      queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          const [session] = yield* Effect.tryPromise(() =>
            db
              .insert(sessions)
              .values({
                orgId: row.orgId,
                machineId: row.machineId,
                personId: row.personId,
                method: "terminal",
                osUser: "ubuntu",
                startedAt: new Date(),
              })
              .returning(),
          );
          if (!session) throw new Error("failed to insert session");
          return session;
        }),
      );

    const seedElevation = (row: {
      orgId: string;
      personId: string;
      machineId: string;
      expiresAt: Date;
    }) =>
      queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          yield* Effect.tryPromise(() =>
            db.insert(elevations).values({
              orgId: row.orgId,
              personId: row.personId,
              machineId: row.machineId,
              level: "shell",
              reason: "test grant",
              approvalId: null,
              grantedAt: new Date(Date.now() - 60_000),
              expiresAt: row.expiresAt,
              status: "granted",
            }),
          );
        }),
      );

    const fetchSession = (sessionId: string) =>
      queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          const rows = yield* Effect.tryPromise(() =>
            db.select().from(sessions).where(eq(sessions.id, sessionId)),
          );
          return rows[0];
        }),
      );

    test("closes a session whose supporting elevation has since expired, tearing down its live connection too", async () => {
      const ctx = await seedOwnedMachineAndStranger();
      const session = await seedOpenSession({
        orgId: ctx.orgId,
        machineId: ctx.machineId,
        personId: ctx.strangerPersonId,
      });
      await seedElevation({
        orgId: ctx.orgId,
        personId: ctx.strangerPersonId,
        machineId: ctx.machineId,
        expiresAt: new Date(Date.now() - 1_000),
      });

      const browser = fakeSocket();
      // Same single-`run()` requirement as every other registry-touching test above.
      await run(
        Effect.gen(function* () {
          const registry = yield* TunnelRegistry;
          yield* registry.registerRelay(session.id, ctx.machineId, browser.socket);
          yield* closeSessionsWithLapsedAuthorization();
        }),
      );

      const updated = await fetchSession(session.id);
      expect(updated?.endedAt).not.toBeNull();
      expect(updated?.terminationReason).toBe("policy_terminated");
      expect(browser.isClosed()).toBe(true);

      // REQUIRED: the audit trail must attribute this to the system, not the person whose
      // session it was — `endSession`'s pre-existing default (`actorType: "person"`,
      // hardcoded to the session's own `personId`) would otherwise misrepresent a
      // system-initiated policy termination as something the person did themselves.
      const emitted = await queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          return yield* Effect.tryPromise(() =>
            db.select().from(events).where(eq(events.correlationId, session.id)),
          );
        }),
      );
      const endedEvent = emitted.find((e) => e.type === "access.session_ended");
      expect(endedEvent?.actorType).toBe("system");
      expect(endedEvent?.actorId).toBe("session-reauthorization");
    });

    test("leaves the machine owner's own open session untouched, with no elevation at all", async () => {
      const ctx = await seedOwnedMachineAndStranger();
      const session = await seedOpenSession({
        orgId: ctx.orgId,
        machineId: ctx.machineId,
        personId: ctx.ownerPersonId,
      });

      await run(closeSessionsWithLapsedAuthorization());

      const unchanged = await fetchSession(session.id);
      expect(unchanged?.endedAt).toBeNull();
    });

    test("leaves a non-owner's session untouched while its shell-level elevation is still valid", async () => {
      const ctx = await seedOwnedMachineAndStranger();
      const session = await seedOpenSession({
        orgId: ctx.orgId,
        machineId: ctx.machineId,
        personId: ctx.strangerPersonId,
      });
      await seedElevation({
        orgId: ctx.orgId,
        personId: ctx.strangerPersonId,
        machineId: ctx.machineId,
        expiresAt: new Date(Date.now() + 3600_000),
      });

      await run(closeSessionsWithLapsedAuthorization());

      const unchanged = await fetchSession(session.id);
      expect(unchanged?.endedAt).toBeNull();
    });

    test("REQUIRED FAILURE PATH: closes a non-owner's session that never had any elevation at all", async () => {
      const ctx = await seedOwnedMachineAndStranger();
      const session = await seedOpenSession({
        orgId: ctx.orgId,
        machineId: ctx.machineId,
        personId: ctx.strangerPersonId,
      });

      await run(closeSessionsWithLapsedAuthorization());

      const updated = await fetchSession(session.id);
      expect(updated?.endedAt).not.toBeNull();
      expect(updated?.terminationReason).toBe("policy_terminated");
    });
  });
});
