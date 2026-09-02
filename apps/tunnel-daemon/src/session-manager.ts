// ---------------------------------------------------------------------------
// The daemon's per-session multiplexing core: one real PTY per
// live session, keyed by `sessionId`. `attach` is where the plan's own
// hard requirement lives — "the agent must validate the signature on every
// session, including under load" — there is no code path here that spawns
// a PTY without a signature check passing first, including on every
// re-attach after a dropped connection, not just the first one.
//
// Dependencies (public-key fetch, PTY spawning) are injected via
// `SessionManagerDeps` rather than imported directly, so the verify/dispatch
// logic here is unit-testable without a real network call or a real PTY —
// `createDefaultSessionManagerDeps` below wires the real
// `session-token-key.ts` + `pty.ts` for actual use.
// ---------------------------------------------------------------------------
import { verifySessionToken } from "@cloudable/session-token";
import { type PtySession, type SpawnSessionOptions, spawnSession as realSpawnSession } from "./pty";
import { clearCachedSessionTokenPublicKey, getSessionTokenPublicKey } from "./session-token-key";

export type AttachOutcome = { ok: true } | { ok: false; reason: string };

export interface AttachInput {
  sessionId: string;
  sessionToken: string;
  cols: number;
  rows: number;
}

export interface SessionManagerDeps {
  /** This daemon's own attested machine id (from `attestation.ts`'s `attest()`) — a session
   * token whose `targetMachineId` claim doesn't match this is rejected, the same way a
   * mis-scoped SSH certificate's `validPrincipals` would be: a token minted for a different
   * machine must never be honored just because it reached this daemon's socket. */
  machineId: string;
  /** The daemon's current bearer session token (`attestation.ts`'s `attest()`), read fresh on
   * every call rather than captured once — the cached session refreshes itself over time. */
  getBearerToken: () => string;
  /** Wraps `session-token-key.ts`'s cache; returns the raw DER bytes, not the base64 string. */
  getSessionTokenPublicKeyBytes: (bearerToken: string) => Promise<Uint8Array>;
  /** Wraps `session-token-key.ts`'s `clearCachedSessionTokenPublicKey` — called once, for one
   * eager retry, specifically on an `invalid_signature` verification failure (the key may
   * have rotated since the last fetch); never on `expired`/`malformed`, which a fresh key
   * can't fix. */
  invalidateSessionTokenPublicKey: () => void;
  spawnSession: (options: SpawnSessionOptions) => PtySession;
}

/** Real deps: the actual cached HTTP fetch (`session-token-key.ts`) and the actual
 * `Bun.Terminal`-backed PTY (`pty.ts`). Wired into the daemon's real connection loop by
 * `index.ts`; tests supply their own fakes instead of this. */
export function createDefaultSessionManagerDeps(options: {
  machineId: string;
  getBearerToken: () => string;
}): SessionManagerDeps {
  return {
    machineId: options.machineId,
    getBearerToken: options.getBearerToken,
    getSessionTokenPublicKeyBytes: async (bearerToken) => {
      const { publicKeyDerBase64 } = await getSessionTokenPublicKey(bearerToken);
      return new Uint8Array(Buffer.from(publicKeyDerBase64, "base64"));
    },
    invalidateSessionTokenPublicKey: clearCachedSessionTokenPublicKey,
    spawnSession: realSpawnSession,
  };
}

export interface SessionManager {
  /** Verifies the session token, and only on success spawns a real PTY for it. `onData`/
   * `onExit` fire for this session's own lifetime; `onData` typically forwards bytes over
   * the daemon's outbound connection as a `data` frame (connection.ts), and `onExit`
   * typically forwards a `close` frame with `reason: "process_exited"` and forgets
   * the session (both callers' job, not this function's). */
  attach: (
    input: AttachInput,
    callbacks: {
      onData: (data: Uint8Array) => void;
      onExit: (info: { exitCode: number | null; signalCode: string | null }) => void;
    },
  ) => Promise<AttachOutcome>;
  data: (sessionId: string, bytes: Uint8Array) => void;
  resize: (sessionId: string, cols: number, rows: number) => void;
  /** Ends one session immediately (policy-triggered close from the control plane, or the
   * browser leg disconnecting) — forcible termination, not a graceful shutdown request; see
   * `pty.ts`'s `kill()` doc comment for why that's the reliable mechanism here. The session
   * is forgotten synchronously, but the underlying process's real exit is async — the
   * `onExit` callback passed to `attach` still fires once the kill actually lands, so a
   * caller that already knows it deliberately closed this session should treat that as
   * informational and not, say, re-send a `close` frame for a session it already ended. */
  close: (sessionId: string) => void;
  has: (sessionId: string) => boolean;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const sessions = new Map<string, PtySession>();

  const verifyOnce = async (sessionToken: string) => {
    const publicKeyDer = await deps.getSessionTokenPublicKeyBytes(deps.getBearerToken());
    return verifySessionToken(sessionToken, publicKeyDer);
  };

  const attach: SessionManager["attach"] = async (input, callbacks) => {
    let result = await verifyOnce(input.sessionToken);

    // One eager refresh-and-retry, only for a signature that doesn't verify against the
    // currently cached key — it may simply be stale after a key rotation. Never retried for
    // `expired`/`malformed`, which no amount of re-fetching the key fixes.
    if (!result.ok && result.reason === "invalid_signature") {
      deps.invalidateSessionTokenPublicKey();
      result = await verifyOnce(input.sessionToken);
    }

    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }

    if (result.claims.targetMachineId !== deps.machineId) {
      return { ok: false, reason: "wrong_machine" };
    }

    // `spawnSession` throws synchronously for a `targetOsUser` that doesn't even look like a
    // real username (`pty.ts`'s `InvalidOsUserError`) or, in principle, any other real spawn
    // failure — caught here rather than left to propagate as an unhandled rejection out of
    // `attach` (an `async` function whose caller, `connection.ts`'s inbound-frame dispatch,
    // invokes it as `void handleInboundFrame(...)` specifically because it does NOT await or
    // otherwise handle a rejection from it).
    let pty: PtySession;
    try {
      pty = deps.spawnSession({
        targetOsUser: result.claims.targetOsUser,
        cols: input.cols,
        rows: input.rows,
        onData: callbacks.onData,
        onExit: (info) => {
          sessions.delete(input.sessionId);
          callbacks.onExit(info);
        },
      });
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : "spawn_failed" };
    }
    sessions.set(input.sessionId, pty);

    return { ok: true };
  };

  const data: SessionManager["data"] = (sessionId, bytes) => {
    sessions.get(sessionId)?.write(bytes);
  };

  const resize: SessionManager["resize"] = (sessionId, cols, rows) => {
    sessions.get(sessionId)?.resize(cols, rows);
  };

  const close: SessionManager["close"] = (sessionId) => {
    const pty = sessions.get(sessionId);
    if (!pty) return;
    pty.kill();
    sessions.delete(sessionId);
  };

  const has: SessionManager["has"] = (sessionId) => sessions.has(sessionId);

  return { attach, data, resize, close, has };
}
