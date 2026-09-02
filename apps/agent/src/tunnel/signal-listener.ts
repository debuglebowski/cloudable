// ---------------------------------------------------------------------------
// Agent-side half of the CP -> agent tunnel-signal channel. See
// `apps/control-plane/src/tunnel/signal.ts`'s header comment for the full
// design reasoning — in short: a *separate* channel from `wake`
// (../wake.ts), because `wake`'s job (accelerate the control agent's own
// desired-state poll) and this channel's job (tell the tunnel client
// "session <id> is waiting, connect now" / "session <id>, stop") are
// unrelated, and `wake` is explicitly barred from carrying any payload at
// all, let alone a session id.
//
// This is a continuous long poll, not a periodic poll like
// `poll-report-loop.ts`'s ~30s cycle: `runTunnelSignalLoop` calls
// `GET /api/v1/tunnel/signal` and lets it hang (server-side, up to
// `apps/control-plane/src/tunnel/signal.ts`'s own ~25s timeout) until
// either a signal arrives or it times out with `signal: null` — either way,
// this loop calls again immediately. There is no `sleep()` between
// iterations on the happy path; the long poll itself *is* the wait.
//
// This module only ever notifies via callbacks — it does not itself open a
// reverse tunnel or touch a PTY. `apps/agent/src/tunnel/client.ts` (a
// sibling unit) is what actually verifies the session token and opens the
// tunnel; wiring a real client in means passing its `connect`/`disconnect`
// methods as `onSessionWaiting`/`onSessionTerminate` here instead of
// `index.ts`'s current log-only defaults.
// ---------------------------------------------------------------------------
import { AttestationRejectedError, clearCachedSession, attest as realAttest } from "../attestation";
import { DEFAULT_BACKOFF, fullJitterBackoffMs } from "../backoff";
import { config } from "../config";
import { ApiError } from "../http-client";
import type { TunnelSignalMessage, TunnelSignalResponse } from "../wire-types";

export interface TunnelSignalCallbacks {
  readonly onSessionWaiting: (sessionId: string) => void;
  readonly onSessionTerminate: (sessionId: string) => void;
}

const isTunnelSignalMessage = (value: unknown): value is TunnelSignalMessage =>
  typeof value === "object" &&
  value !== null &&
  ((value as { type?: unknown }).type === "session_waiting" ||
    (value as { type?: unknown }).type === "session_terminate") &&
  typeof (value as { sessionId?: unknown }).sessionId === "string";

const isTunnelSignalResponse = (value: unknown): value is TunnelSignalResponse =>
  typeof value === "object" &&
  value !== null &&
  ((value as { signal?: unknown }).signal === null ||
    isTunnelSignalMessage((value as { signal?: unknown }).signal));

/** Injectable for tests — mirrors the `deps` pattern already used for the tunnel connection's
 * own reconnect loop conventions elsewhere in this codebase (e.g. `apps/tunnel-daemon`'s
 * `connection.ts`, once that unit lands): real implementations by default, fakes in tests so
 * no test needs a real network call or a real timer. */
export interface TunnelSignalLoopDeps {
  fetchImpl?: typeof fetch;
  attest?: () => Promise<{ bearerToken: string }>;
  sleep?: (ms: number) => Promise<void>;
}

async function fetchNextSignal(
  fetchImpl: typeof fetch,
  bearerToken: string,
  signal: AbortSignal | undefined,
): Promise<TunnelSignalMessage | null> {
  const res = await fetchImpl(`${config.controlPlaneUrl}/api/v1/tunnel/signal`, {
    headers: { authorization: `Bearer ${bearerToken}` },
    // Wired through so an abort actually cuts off this specific in-flight long poll (up to
    // ~25s otherwise) rather than only being noticed the next time the loop's own top-level
    // check runs, after this call already settled on its own. `?? null`, not `undefined` —
    // `RequestInit.signal` is typed `AbortSignal | null`, and this repo's `exactOptionalPropertyTypes`
    // means `undefined` doesn't structurally satisfy that on its own.
    signal: signal ?? null,
  });
  if (!res.ok) {
    throw new ApiError(res.status, await res.json().catch(() => undefined));
  }
  const body: unknown = await res.json();
  if (!isTunnelSignalResponse(body)) {
    // A malformed response from the control plane — treat like an empty long poll rather
    // than crashing the whole loop over one bad frame (same posture
    // `poll-report-loop.ts`/`../wake.ts`'s inbound-message handling takes).
    return null;
  }
  return body.signal;
}

const dispatch = (callbacks: TunnelSignalCallbacks, message: TunnelSignalMessage): void => {
  if (message.type === "session_waiting") callbacks.onSessionWaiting(message.sessionId);
  else callbacks.onSessionTerminate(message.sessionId);
};

/**
 * The tunnel-signal listener's main loop: attest, long-poll
 * `/api/v1/tunnel/signal`, dispatch whatever comes back (if anything), and
 * call again immediately — forever. On failure, backs off with the same
 * full-jitter strategy `poll-report-loop.ts` uses, for the identical
 * reason ("the failure mode is a synchronised fleet-wide storm after a
 * control plane outage" applies here just as much as it does to the
 * regular poll/report cycle).
 *
 * Runs forever; `options.signal` is the only way out (used by tests).
 */
export async function runTunnelSignalLoop(
  callbacks: TunnelSignalCallbacks,
  deps: TunnelSignalLoopDeps = {},
  options: { signal?: AbortSignal } = {},
): Promise<never> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const attest = deps.attest ?? realAttest;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;

  for (;;) {
    if (options.signal?.aborted) {
      throw new Error("tunnel signal loop aborted");
    }

    try {
      const session = await attest();
      const message = await fetchNextSignal(fetchImpl, session.bearerToken, options.signal);
      if (message) dispatch(callbacks, message);
      attempt = 0;
      // No `sleep()` here on the happy path (signal delivered or a clean timeout) — the
      // long poll itself is the wait; looping immediately is the whole point of long
      // polling instead of the ~30s fixed cadence `poll-report-loop.ts` uses.
    } catch (error) {
      if (error instanceof AttestationRejectedError) {
        console.error(`tunnel-signal: attestation rejected: ${error.reason} — check MACHINE_TOKEN`);
      } else if (error instanceof ApiError && error.status === 401) {
        console.error("tunnel-signal: bearer session rejected — re-attesting next cycle");
        clearCachedSession();
      } else {
        console.error(`tunnel-signal: long-poll cycle failed: ${String(error)}`);
      }

      // Check again immediately, before backing off — an abort that just cut off the
      // in-flight long poll above (via the `signal` now threaded into `fetchNextSignal`)
      // surfaces here as a thrown `AbortError`, indistinguishable from any other fetch
      // failure to the branches above; without this, a deliberate shutdown would pay a full,
      // pointless backoff delay before this loop noticed it's supposed to be stopping.
      if (options.signal?.aborted) {
        throw new Error("tunnel signal loop aborted");
      }

      const delay = fullJitterBackoffMs(attempt, DEFAULT_BACKOFF);
      attempt += 1;
      console.log(
        `tunnel-signal: backing off ${Math.round(delay)}ms before retrying (attempt ${attempt})`,
      );
      await sleep(delay);
    }
  }
}
