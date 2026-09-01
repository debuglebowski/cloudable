// Runs against the local dev Postgres — see `../services/ssh-ca/SshCaService.test.ts` for why
// (testcontainers timed out in this sandbox). Every row is scoped to a fresh random `orgId`.
import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import {
  events,
  elevations,
  machines,
  orgs,
  people,
  sessions,
  settingValues,
} from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { Db, DbLive } from "../db/layer";
import { ACCESS_METHODS_ENABLED_KEY } from "../domain/machine/settings";
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
      // The minted token is persisted, not just returned — this is what an attach handler
      // replays to the daemon later (the browser never resupplies it, per the approved plan).
      expect(sessionRow?.sessionToken).toBe(minted.token);

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

  // REQUIRED FAILURE PATH: mintSession's machine lookup used to be `WHERE id = ?` with no
  // org filter at all — a machine belonging to a DIFFERENT org than the caller resolved
  // successfully, letting any authenticated person in any org mint a session against any
  // other org's machine by id (a cross-tenant IDOR). It must resolve exactly like a
  // nonexistent machine: same "machine_not_found" reason, never a distinct "wrong org"
  // reason that would confirm the id belongs to someone else's tenant.
  test("REQUIRED FAILURE PATH: mintSession against a real machine in a DIFFERENT org is denied with machine_not_found, not leaked as a distinct reason", async () => {
    await withOrgAndMachine("running", async ({ machineId }) => {
      const otherOrgId = crypto.randomUUID();
      const program = Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        return yield* tunnel.mintSession({
          orgId: otherOrgId,
          personId: crypto.randomUUID(),
          idpIdentity: "kalle@normain.com",
          targetMachineId: machineId,
          targetOsUser: "ubuntu",
          method: "terminal",
        });
      });
      const error = await Effect.runPromise(Effect.provide(Effect.flip(program), TestLayer));
      expect(error.reason).toBe("denied");
      expect(error.detail).toBe("machine_not_found");

      // Session bookkeeping must show no trace of a session against the real machine
      // under the wrong org — a leaked cross-org session row would itself be a tenant
      // isolation break in the audit trail, denial or not.
      const sessionRows = await queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          return yield* Effect.tryPromise(() =>
            db.select().from(sessions).where(eq(sessions.machineId, machineId)),
          );
        }),
      );
      expect(sessionRows).toHaveLength(0);
    });
  });

  // REQUIRED FAILURE PATH: a malformed targetOsUser must never reach a signed token — see
  // `server.ts`'s `OS_USERNAME_PATTERN` doc comment for the real privilege-escalation
  // scenario this closes (a value like "-c" hijacking `su`'s own argument parsing daemon-side).
  test("REQUIRED FAILURE PATH: mintSession rejects a malformed targetOsUser before ever minting a token", async () => {
    await withOrgAndMachine("running", async ({ orgId, machineId }) => {
      const program = Effect.gen(function* () {
        const tunnel = yield* TunnelServer;
        return yield* tunnel.mintSession({
          orgId,
          personId: crypto.randomUUID(),
          idpIdentity: "kalle@normain.com",
          targetMachineId: machineId,
          targetOsUser: "-c",
          method: "terminal",
        });
      });
      const error = await Effect.runPromise(Effect.provide(Effect.flip(program), TestLayer));
      expect(error.reason).toBe("denied");
      expect(error.detail).toBe("invalid_target_os_user");

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

  // Spec §11: "Access method is policy, inherited through the chain." These four tests
  // cover: no configured policy (default = both enabled), an org-level restriction, a
  // machine-level override of an org-level restriction, and a machine-level restriction on
  // top of no org-level setting at all — the same org→machine chain every other inherited
  // setting in this codebase uses.
  describe("mintSession: access method policy (spec §11)", () => {
    test("with no access_methods setting configured anywhere, both terminal and ssh are allowed", async () => {
      await withOrgAndMachine("running", async ({ orgId, machineId }) => {
        for (const method of ["terminal", "ssh"] as const) {
          const minted = await Effect.runPromise(
            Effect.provide(
              Effect.gen(function* () {
                const tunnel = yield* TunnelServer;
                return yield* tunnel.mintSession({
                  orgId,
                  personId: crypto.randomUUID(),
                  idpIdentity: "kalle@normain.com",
                  targetMachineId: machineId,
                  targetOsUser: "ubuntu",
                  method,
                });
              }),
              TestLayer,
            ),
          );
          expect(minted.sessionId).toBeTruthy();
        }
      });
    });

    test("REQUIRED FAILURE PATH: an org-level access_methods setting that excludes a method denies mintSession with method_disabled", async () => {
      await withOrgAndMachine("running", async ({ orgId, machineId }) => {
        await queryDb(
          Effect.gen(function* () {
            const db = yield* Db;
            yield* Effect.tryPromise(() =>
              db.insert(settingValues).values({
                scopeType: "org",
                scopeId: orgId,
                key: ACCESS_METHODS_ENABLED_KEY,
                value: { webTerminal: false, ssh: true },
                source: "org",
              }),
            );
          }),
        );

        const program = Effect.gen(function* () {
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
        const error = await Effect.runPromise(Effect.provide(Effect.flip(program), TestLayer));
        expect(error.reason).toBe("denied");
        expect(error.detail).toBe("method_disabled");
      });
    });

    test("a machine-level access_methods setting overrides an org-level restriction (lowest scope wins)", async () => {
      await withOrgAndMachine("running", async ({ orgId, machineId }) => {
        await queryDb(
          Effect.gen(function* () {
            const db = yield* Db;
            yield* Effect.tryPromise(() =>
              db.insert(settingValues).values([
                {
                  scopeType: "org",
                  scopeId: orgId,
                  key: ACCESS_METHODS_ENABLED_KEY,
                  value: { webTerminal: false, ssh: true },
                  source: "org",
                },
                {
                  scopeType: "machine",
                  scopeId: machineId,
                  key: ACCESS_METHODS_ENABLED_KEY,
                  value: { webTerminal: true, ssh: true },
                  source: "machine",
                },
              ]),
            );
          }),
        );

        const minted = await Effect.runPromise(
          Effect.provide(
            Effect.gen(function* () {
              const tunnel = yield* TunnelServer;
              return yield* tunnel.mintSession({
                orgId,
                personId: crypto.randomUUID(),
                idpIdentity: "kalle@normain.com",
                targetMachineId: machineId,
                targetOsUser: "ubuntu",
                method: "terminal",
              });
            }),
            TestLayer,
          ),
        );
        expect(minted.sessionId).toBeTruthy();
      });
    });

    test("REQUIRED FAILURE PATH: a machine-level restriction denies mintSession even with no org-level setting at all", async () => {
      await withOrgAndMachine("running", async ({ orgId, machineId }) => {
        await queryDb(
          Effect.gen(function* () {
            const db = yield* Db;
            yield* Effect.tryPromise(() =>
              db.insert(settingValues).values({
                scopeType: "machine",
                scopeId: machineId,
                key: ACCESS_METHODS_ENABLED_KEY,
                value: { webTerminal: true, ssh: false },
                source: "machine",
              }),
            );
          }),
        );

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
        expect(error.detail).toBe("method_disabled");
      });
    });
  });

  // Spec §15: "Admin connecting to a machine they do not own" needs a granted elevation.
  // Every other test in this file mints against a NULL-owner machine (the established
  // fixture shape for everything above), which this gate deliberately exempts — see
  // `access-authorization.ts`'s own doc comment. These tests need a REAL owner, so they
  // use their own seeding helper rather than `withOrgAndMachine` (which always creates a
  // fresh org internally and has no way to attach a pre-existing person to it as owner).
  describe("mintSession: ownership & elevation (spec §15)", () => {
    const seedOrgAndOwnedMachine = () =>
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
          return { orgId: org.id, machineId: machine.id, ownerPersonId: owner.id };
        }),
      );

    const seedPerson = (orgId: string) =>
      queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          const [person] = yield* Effect.tryPromise(() =>
            db
              .insert(people)
              .values({ orgId, email: `${crypto.randomUUID()}@example.com`, role: "member" })
              .returning(),
          );
          if (!person) throw new Error("failed to insert person");
          return person;
        }),
      );

    const seedElevation = (row: {
      orgId: string;
      personId: string;
      machineId: string;
      level: "file_recovery" | "shell";
      status: "granted";
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
              level: row.level,
              reason: "test grant",
              approvalId: null,
              grantedAt: new Date(Date.now() - 60_000),
              expiresAt: row.expiresAt,
              status: row.status,
            }),
          );
        }),
      );

    const mint = (personId: string, orgId: string, machineId: string) =>
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

    test("the machine's own owner may open a session with no elevation at all", async () => {
      const { orgId, machineId, ownerPersonId } = await seedOrgAndOwnedMachine();
      const minted = await Effect.runPromise(
        Effect.provide(mint(ownerPersonId, orgId, machineId), TestLayer),
      );
      expect(minted.sessionId).toBeTruthy();
    });

    test("REQUIRED FAILURE PATH: a non-owner with no elevation is denied with elevation_required", async () => {
      const { orgId, machineId } = await seedOrgAndOwnedMachine();
      const stranger = await seedPerson(orgId);
      const error = await Effect.runPromise(
        Effect.provide(Effect.flip(mint(stranger.id, orgId, machineId)), TestLayer),
      );
      expect(error.reason).toBe("denied");
      expect(error.detail).toBe("elevation_required");
    });

    test("a non-owner with a granted, unexpired, shell-level elevation for that machine may open a session", async () => {
      const { orgId, machineId } = await seedOrgAndOwnedMachine();
      const stranger = await seedPerson(orgId);
      await seedElevation({
        orgId,
        personId: stranger.id,
        machineId,
        level: "shell",
        status: "granted",
        expiresAt: new Date(Date.now() + 3600_000),
      });

      const minted = await Effect.runPromise(
        Effect.provide(mint(stranger.id, orgId, machineId), TestLayer),
      );
      expect(minted.sessionId).toBeTruthy();
    });

    test("REQUIRED FAILURE PATH: a file_recovery-level elevation does not satisfy the shell-level gate", async () => {
      const { orgId, machineId } = await seedOrgAndOwnedMachine();
      const stranger = await seedPerson(orgId);
      await seedElevation({
        orgId,
        personId: stranger.id,
        machineId,
        level: "file_recovery",
        status: "granted",
        expiresAt: new Date(Date.now() + 3600_000),
      });

      const error = await Effect.runPromise(
        Effect.provide(Effect.flip(mint(stranger.id, orgId, machineId)), TestLayer),
      );
      expect(error.detail).toBe("elevation_required");
    });

    test("REQUIRED FAILURE PATH: an already-expired shell-level elevation does not satisfy the gate", async () => {
      const { orgId, machineId } = await seedOrgAndOwnedMachine();
      const stranger = await seedPerson(orgId);
      await seedElevation({
        orgId,
        personId: stranger.id,
        machineId,
        level: "shell",
        status: "granted",
        expiresAt: new Date(Date.now() - 1_000),
      });

      const error = await Effect.runPromise(
        Effect.provide(Effect.flip(mint(stranger.id, orgId, machineId)), TestLayer),
      );
      expect(error.detail).toBe("elevation_required");
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
        yield* tunnel.endSession({ orgId, sessionId: minted.sessionId, reason: "person_ended" });
      });
      await Effect.runPromise(Effect.provide(end, TestLayer));

      const { row, endedEvent } = await queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          const rows = yield* Effect.tryPromise(() =>
            db.select().from(sessions).where(eq(sessions.id, minted.sessionId)),
          );
          const evRows = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(events)
              .where(eq(events.correlationId, minted.sessionId))
              .then((r) => r.filter((e) => e.type === "access.session_ended")),
          );
          return { row: rows[0], endedEvent: evRows[0] };
        }),
      );
      expect(row?.endedAt).not.toBeNull();
      expect(row?.durationSeconds).toBeGreaterThanOrEqual(0);
      // `reason` is now persisted (previously silently discarded) — both on the row and in
      // the event payload.
      expect(row?.terminationReason).toBe("person_ended");
      expect(endedEvent?.payload).toMatchObject({ reason: "person_ended" });

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

      const { rows, endedEvents } = await queryDb(
        Effect.gen(function* () {
          const db = yield* Db;
          const sessionRows = yield* Effect.tryPromise(() =>
            db.select().from(sessions).where(eq(sessions.machineId, machineId)),
          );
          const evRows = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(events)
              .where(eq(events.machineId, machineId))
              .then((r) => r.filter((e) => e.type === "access.session_ended")),
          );
          return { rows: sessionRows, endedEvents: evRows };
        }),
      );
      expect(rows.every((r) => r.endedAt !== null)).toBe(true);
      expect(rows.map((r) => r.id).sort()).toEqual([a.sessionId, b.sessionId].sort());
      // `reason` is now persisted per row and per emitted event (previously silently
      // discarded — `terminateSessionsForMachine`'s `reason` param had zero effect on either).
      expect(rows.every((r) => r.terminationReason === "access disabled by policy")).toBe(true);
      expect(endedEvents).toHaveLength(2);
      expect(
        endedEvents.every(
          (e) => (e.payload as { reason?: string }).reason === "access disabled by policy",
        ),
      ).toBe(true);
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
