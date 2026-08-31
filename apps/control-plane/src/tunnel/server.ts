import { machines, sessions } from "@cloudable/schema";
// ---------------------------------------------------------------------------
// Control-plane side of session brokering (spec §11.1 web terminal, and the
// SSH-certificate path's session accounting). Mints signed session tokens,
// persists `sessions` rows, and emits the `access.session_*` events.
//
// STUB, deliberately: the actual reverse-tunnel network transport (the
// tunnel daemon relaying bytes between a browser/ssh client and a machine's
// outbound connection) is NOT implemented here — there is no fleet of real
// machines to tunnel to in this build, and the cross-unit brief explicitly
// allows a documented stub for the transport while requiring token
// minting/verification to be fully real (see docs/access.md). What's real:
// the policy check, the signed token (session-token.ts, fully tested
// including the tamper failure path), the `sessions` row lifecycle, and
// every emitted event.
//
// One piece of the transport IS real now, though: `signal.ts`'s
// tunnel-signal channel, pushed to on `mintSession` success and on every
// session `endSession`/`terminateSessionsForMachine` end. It never carries
// bytes, only "session <id> is waiting, connect now" / "session <id>, stop"
// — the minimal thing a machine's agent needs to know to start (or stop)
// using the still-stubbed byte-relay transport, once a sibling unit builds
// it (`apps/agent/src/tunnel/client.ts`). See `signal.ts`'s own header
// comment for why this is a new channel rather than a repurposed `wake`.
// ---------------------------------------------------------------------------
import { and, eq, isNull } from "drizzle-orm";
import { Data, Effect } from "effect";
import { Db } from "../db/layer";
import { EventBus } from "../services/EventBus";
import type { SignerTag } from "../services/Signer";
import { type SessionMethod, mintSessionToken } from "./session-token";
import { TunnelSignal } from "./signal";

export class TunnelError extends Data.TaggedError("TunnelError")<{
  reason: "denied" | "not_found" | "lookup_failed" | "persist_failed" | "sign_failed";
  detail?: string;
  cause?: unknown;
}> {}

export interface MintSessionInput {
  orgId: string;
  personId: string;
  idpIdentity: string;
  targetMachineId: string;
  targetOsUser: string;
  method: SessionMethod;
}

export interface MintedSession {
  sessionId: string;
  token: string;
  expiresAt: Date;
}

export interface EndSessionInput {
  sessionId: string;
  orgId: string;
}

const durationSecondsSince = (startedAt: Date, now: Date): number =>
  Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));

/**
 * Session brokering. `mintSession` is the one real policy gate this build
 * has for access: it denies (and emits `access.session_denied`, with a
 * reason) a request against a machine that does not exist or is not
 * `running` — an archived or stopped machine has no live tunnel daemon
 * connection to attach a session to. `terminateSessionsForMachine` is the
 * "disabling terminates live sessions" path from spec §11.1, callable
 * independent of whether the transport that would carry the disconnect
 * signal to a real tunnel daemon exists yet.
 */
export class TunnelServer extends Effect.Service<TunnelServer>()("TunnelServer", {
  effect: Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const tunnelSignal = yield* TunnelSignal;

    const mintSession = (
      input: MintSessionInput,
    ): Effect.Effect<MintedSession, TunnelError, SignerTag> =>
      Effect.gen(function* () {
        const now = new Date();

        const found = yield* Effect.tryPromise({
          try: () =>
            db.select().from(machines).where(eq(machines.id, input.targetMachineId)).limit(1),
          catch: (cause) => new TunnelError({ reason: "lookup_failed", cause }),
        });
        const machine = found[0];

        const denialReason = !machine
          ? "machine_not_found"
          : machine.state !== "running"
            ? `machine_${machine.state}`
            : null;

        if (denialReason) {
          yield* eventBus
            .publish([
              {
                id: "",
                recordedAt: now,
                type: "access.session_denied",
                occurredAt: now,
                orgId: input.orgId,
                actorType: "person",
                actorId: input.personId,
                machineId: machine?.id ?? null,
                correlationId: input.targetMachineId,
                schemaVersion: 1,
                payload: { reason: denialReason, method: input.method },
              },
            ])
            .pipe(Effect.mapError((cause) => new TunnelError({ reason: "persist_failed", cause })));

          return yield* Effect.fail(new TunnelError({ reason: "denied", detail: denialReason }));
        }

        const minted = yield* mintSessionToken({
          idpIdentity: input.idpIdentity,
          targetMachineId: input.targetMachineId,
          targetOsUser: input.targetOsUser,
          method: input.method,
        }).pipe(Effect.mapError((cause) => new TunnelError({ reason: "sign_failed", cause })));

        const sessionId = yield* Effect.tryPromise({
          try: async () => {
            const [row] = await db
              .insert(sessions)
              .values({
                orgId: input.orgId,
                machineId: input.targetMachineId,
                personId: input.personId,
                method: input.method,
                osUser: input.targetOsUser,
                startedAt: now,
              })
              .returning({ id: sessions.id });
            if (!row) throw new Error("insert returned no row");
            return row.id;
          },
          catch: (cause) => new TunnelError({ reason: "persist_failed", cause }),
        });

        yield* eventBus
          .publish([
            {
              id: "",
              recordedAt: now,
              type: "access.session_started",
              occurredAt: now,
              orgId: input.orgId,
              actorType: "person",
              actorId: input.personId,
              machineId: input.targetMachineId,
              correlationId: sessionId,
              schemaVersion: 1,
              payload: { method: input.method, osUser: input.targetOsUser },
            },
          ])
          .pipe(Effect.mapError((cause) => new TunnelError({ reason: "persist_failed", cause })));

        // Tell the target machine's agent "session <id> is waiting, connect now" — the
        // tunnel-signal channel (tunnel/signal.ts), deliberately separate from `wake`. Pushed
        // only after the `sessions` row and `access.session_started` event are both durably
        // written, same ordering `EndSessionInput`'s own callers rely on elsewhere in this
        // file: a session that isn't real yet in the database must never be signaled as real
        // to the agent. Best-effort and cannot fail this call — if no agent is currently
        // long-polling for this machine (or ever connects), the signal is queued for the next
        // one, and the person minting the session simply sees no live tunnel, same as today.
        yield* tunnelSignal.push(input.targetMachineId, {
          type: "session_waiting",
          sessionId,
        });

        return { sessionId, token: minted.token, expiresAt: minted.expiresAt };
      });

    /**
     * Person-initiated session end — the one production path that already has a real,
     * wired HTTP endpoint (`POST /api/v1/access/sessions/end`, unlike
     * `terminateSessionsForMachine` below, which nothing calls yet). Pushes a
     * `session_terminate` tunnel signal for the same reason `mintSession` pushes
     * `session_waiting`: without it, ending a session here only ever updates the `sessions`
     * row — a real tunnel client (once built) would have no way to learn its session should
     * disconnect, and would keep the reverse tunnel open indefinitely.
     */
    const endSession = (input: EndSessionInput): Effect.Effect<void, TunnelError> =>
      Effect.gen(function* () {
        const now = new Date();
        const updated = yield* Effect.tryPromise({
          try: () =>
            db
              .update(sessions)
              .set({ endedAt: now })
              .where(
                and(
                  eq(sessions.id, input.sessionId),
                  eq(sessions.orgId, input.orgId),
                  isNull(sessions.endedAt),
                ),
              )
              .returning(),
          catch: (cause) => new TunnelError({ reason: "persist_failed", cause }),
        });

        const row = updated[0];
        if (!row) {
          return yield* Effect.fail(
            new TunnelError({ reason: "not_found", detail: `no live session ${input.sessionId}` }),
          );
        }

        const durationSeconds = durationSecondsSince(row.startedAt, now);
        yield* Effect.tryPromise({
          try: () => db.update(sessions).set({ durationSeconds }).where(eq(sessions.id, row.id)),
          catch: (cause) => new TunnelError({ reason: "persist_failed", cause }),
        });

        yield* eventBus
          .publish([
            {
              id: "",
              recordedAt: now,
              type: "access.session_ended",
              occurredAt: now,
              orgId: input.orgId,
              actorType: "person",
              actorId: row.personId,
              machineId: row.machineId,
              correlationId: row.id,
              schemaVersion: 1,
              payload: { durationSeconds },
            },
          ])
          .pipe(Effect.mapError((cause) => new TunnelError({ reason: "persist_failed", cause })));

        yield* tunnelSignal.push(row.machineId, {
          type: "session_terminate",
          sessionId: row.id,
        });
      });

    /**
     * "Disabling terminates live sessions" (spec §11.1) / policy-change
     * termination. Ends every still-open session against `machineId`,
     * regardless of how it started, and emits `access.session_ended` for
     * each. `reason` is accepted for the caller's own logging/audit
     * trail but is not persisted as a distinct column — neither
     * `sessions` nor the `access.session_ended` payload (both already
     * built by an earlier unit) carry a termination-reason field; see
     * docs/access.md for this tradeoff.
     *
     * Also pushes one `session_terminate` tunnel signal per session ended,
     * down the exact same channel `mintSession` uses — this is the piece
     * that makes a policy-disable action actually reach a *connected*
     * agent, not just flip the `sessions` DB row. Before this, a caller of
     * this function (still none in production — see docs/access.md) closed
     * the database's idea of the session while any live tunnel connection
     * for it kept running until the agent's own side noticed some other
     * way (or never did).
     */
    const terminateSessionsForMachine = (input: {
      orgId: string;
      machineId: string;
      reason: string;
    }): Effect.Effect<number, TunnelError> =>
      Effect.gen(function* () {
        const now = new Date();
        const active = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(sessions)
              .where(
                and(
                  eq(sessions.machineId, input.machineId),
                  eq(sessions.orgId, input.orgId),
                  isNull(sessions.endedAt),
                ),
              ),
          catch: (cause) => new TunnelError({ reason: "persist_failed", cause }),
        });

        for (const row of active) {
          const durationSeconds = durationSecondsSince(row.startedAt, now);
          yield* Effect.tryPromise({
            try: () =>
              db
                .update(sessions)
                .set({ endedAt: now, durationSeconds })
                .where(eq(sessions.id, row.id)),
            catch: (cause) => new TunnelError({ reason: "persist_failed", cause }),
          });

          yield* eventBus
            .publish([
              {
                id: "",
                recordedAt: now,
                type: "access.session_ended",
                occurredAt: now,
                orgId: input.orgId,
                actorType: "system",
                actorId: "policy_termination",
                machineId: row.machineId,
                correlationId: row.id,
                schemaVersion: 1,
                payload: { durationSeconds },
              },
            ])
            .pipe(Effect.mapError((cause) => new TunnelError({ reason: "persist_failed", cause })));

          yield* tunnelSignal.push(input.machineId, {
            type: "session_terminate",
            sessionId: row.id,
          });
        }

        return active.length;
      });

    return { mintSession, endSession, terminateSessionsForMachine } as const;
  }),
}) {}
