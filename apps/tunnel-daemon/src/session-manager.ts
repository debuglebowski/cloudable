import type { FsOp } from "@cloudable/contracts";
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
import {
  type FilesSession,
  type SpawnFilesSessionOptions,
  spawnFilesSession as realSpawnFilesSession,
} from "./files-session";
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
  /** The `method: "files"` counterpart of `spawnSession` — see `files-session.ts`. */
  spawnFilesSession: (options: SpawnFilesSessionOptions) => FilesSession;
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
    spawnFilesSession: realSpawnFilesSession,
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
      /** Only ever called for a `method: "files"` session. */
      onFsResult: (requestId: string, result: import("@cloudable/contracts").FsResult) => void;
      /** Only ever called for a `method: "files"` session. */
      onFsChunk: (
        requestId: string,
        chunk: { seq: number; dataBase64: string; final: boolean },
      ) => void;
    },
  ) => Promise<AttachOutcome>;
  data: (sessionId: string, bytes: Uint8Array) => void;
  resize: (sessionId: string, cols: number, rows: number) => void;
  /**
   * Forwards one filesystem operation. A no-op for a session that is not a file
   * session — which is what stops a terminal session from issuing file operations
   * by sending an `fs_request` frame. Session KIND is fixed at attach by the signed
   * token's `method` claim; no later frame can change or bypass it.
   */
  fsRequest: (sessionId: string, requestId: string, op: FsOp) => void;
  /** One slice of an upload. Same no-op rule as `fsRequest`. */
  fsChunk: (
    sessionId: string,
    requestId: string,
    chunk: { seq: number; dataBase64: string; final: boolean },
  ) => void;
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
  // Two maps rather than one union-typed map, keyed by the same `sessionId`. A session is
  // in exactly one of them, decided at attach by the token, and each map's operations are
  // only reachable through its own lookup — so "can this session run a shell command" and
  // "can this session read a file" are answered by which map the id is in, not by a
  // runtime tag a caller could get wrong.
  const sessions = new Map<string, PtySession>();
  const fileSessions = new Map<string, FilesSession>();

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

    // WHICH KIND OF SESSION THIS IS COMES FROM THE VERIFIED TOKEN, NEVER FROM THE FRAME.
    //
    // `input` is the `attach` frame, relayed from the browser through the control plane;
    // `result.claims` is what the control plane actually signed. Branching on the claim is
    // what makes the two elevation levels real: a token minted for `"files"` (which a
    // `file_recovery` grant can obtain, see the control plane's
    // `tunnel/access-authorization.ts`) cannot be made to spawn a PTY by a caller who
    // rewrites the frame, because the frame is not consulted. Reading this from `input`
    // would hand anyone who can reach this socket a shell on a file-recovery grant.
    //
    // Both spawns throw synchronously for a `targetOsUser` that doesn't look like a real
    // username (`pty.ts`'s `InvalidOsUserError`) or, in principle, any other real spawn
    // failure — caught here rather than left to propagate as an unhandled rejection out of
    // `attach` (an `async` function whose caller, `connection.ts`'s inbound-frame dispatch,
    // invokes it as `void handleInboundFrame(...)` specifically because it does NOT await or
    // otherwise handle a rejection from it).
    // A re-attach on a live `sessionId` is expected, not an error (`registry.ts` permits
    // it on reconnect), but the previous child has to die first. Overwriting the map entry
    // alone orphans a process running as the session user with an open stdin pipe, and
    // nothing ever reaps it — the session it belonged to is gone, so no `close` will name
    // it again.
    closeSession(input.sessionId);

    // Exhaustive, with no default branch — a method this daemon does not implement is
    // REFUSED, never served as something else.
    //
    // This used to be `if (files) ... else ...`, which meant anything that was not exactly
    // "files" spawned a full PTY. That was safe only because the claims guard in
    // `@cloudable/session-token` rejected unknown methods before they reached here — a
    // load-bearing coupling that was invisible from either file. The guard is now
    // deliberately permissive so version skew reports honestly (see its own comment), which
    // makes this the place that decides capability, so it has to fail closed. A future
    // lower-privilege method reaching an older daemon must not become a shell.
    if (
      result.claims.method !== "files" &&
      result.claims.method !== "terminal" &&
      result.claims.method !== "ssh"
    ) {
      return { ok: false, reason: "unsupported_method" };
    }

    try {
      if (result.claims.method === "files") {
        const files = deps.spawnFilesSession({
          targetOsUser: result.claims.targetOsUser,
          onResult: callbacks.onFsResult,
          onChunk: callbacks.onFsChunk,
          onExit: (info) => {
            fileSessions.delete(input.sessionId);
            callbacks.onExit(info);
          },
        });
        fileSessions.set(input.sessionId, files);
      } else {
        const pty = deps.spawnSession({
          targetOsUser: result.claims.targetOsUser,
          cols: input.cols,
          rows: input.rows,
          onData: callbacks.onData,
          onExit: (info) => {
            sessions.delete(input.sessionId);
            callbacks.onExit(info);
          },
        });
        sessions.set(input.sessionId, pty);
      }
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : "spawn_failed" };
    }

    return { ok: true };
  };

  const data: SessionManager["data"] = (sessionId, bytes) => {
    sessions.get(sessionId)?.write(bytes);
  };

  const resize: SessionManager["resize"] = (sessionId, cols, rows) => {
    sessions.get(sessionId)?.resize(cols, rows);
  };

  const fsRequest: SessionManager["fsRequest"] = (sessionId, requestId, op) => {
    fileSessions.get(sessionId)?.request(requestId, op);
  };

  const fsChunk: SessionManager["fsChunk"] = (sessionId, requestId, chunk) => {
    fileSessions.get(sessionId)?.chunk(requestId, chunk);
  };

  /**
   * Kills whatever this id names, in BOTH maps.
   *
   * Deliberately not an early return after the PTY branch: an id should only ever be in one
   * map, but "should only ever" is exactly the assumption that leaves a `su` child running
   * as the session user forever when it turns out to be wrong. Checking both is two map
   * lookups and removes the failure mode.
   */
  const closeSession = (sessionId: string): void => {
    const pty = sessions.get(sessionId);
    if (pty) {
      pty.kill();
      sessions.delete(sessionId);
    }
    const files = fileSessions.get(sessionId);
    if (files) {
      files.kill();
      fileSessions.delete(sessionId);
    }
  };

  const close: SessionManager["close"] = closeSession;

  const has: SessionManager["has"] = (sessionId) =>
    sessions.has(sessionId) || fileSessions.has(sessionId);

  return { attach, data, resize, fsRequest, fsChunk, close, has };
}
