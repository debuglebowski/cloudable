import { listRunningAccessMethods } from "./access-methods";
import { AttestationRejectedError, attest, clearCachedSession } from "./attestation";
import { DEFAULT_BACKOFF, fullJitterBackoffMs } from "./backoff";
import { config } from "./config";
import { ApiError } from "./http-client";
import { listInstalledPackages } from "./installed-packages";
import { listOpenPorts } from "./open-ports";
import { connectWake } from "./wake";
import type { AgentReportRequest, AgentReportResponse, DesiredStateResponse } from "./wire-types";

/**
 * The agent's own build version, reported as part of observed state (spec
 * §8.1). `bun build`'s `--env 'AGENT_VERSION*'` flag (see package.json's
 * `build`/`build:arm64` scripts) inlines `process.env.AGENT_VERSION` — set
 * from this package's own `package.json` `version` field at build time,
 * see those scripts — as a literal into the compiled binary, so a released
 * binary reports its real version with no `package.json` alongside it to
 * read at runtime. `bun run dev` never sets that env var, so the fallback
 * below is also the honest answer for local development.
 */
export const AGENT_VERSION = process.env.AGENT_VERSION ?? "0.0.0-dev";

const POLL_INTERVAL_MS = 30_000;

/**
 * Resolves after `ms`, or immediately if `pullNow()` is called first — the
 * mechanism the wake fast path (`wake.ts`) short-circuits onto instead of
 * this loop waiting out the rest of its interval or backoff. Only one wait
 * is ever pending at a time in this loop, so a single pending slot is
 * enough — a `pullNow()` with nothing pending (no sleep in progress, e.g.
 * mid-poll) is simply a no-op: there's nothing to cut short yet, and the
 * next sleep call will run to completion normally, which is fine since the
 * loop was already about to poll anyway.
 *
 * `signal`, when given, is also wired into *every* `wait()` call (not a
 * single listener attached once outside): each call checks `signal.aborted`
 * up front and attaches its own listener, so an abort that lands mid-cycle
 * (during `attest`/`poll`/`report`, with nothing pending yet) still resolves
 * the very next `wait()` immediately instead of only cutting short a wait
 * that happened to already be in progress.
 */
function makeWaker(signal?: AbortSignal): {
  wait: (ms: number) => Promise<void>;
  pullNow: () => void;
} {
  let pending: (() => void) | undefined;
  return {
    wait(ms: number): Promise<void> {
      if (signal?.aborted) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending = undefined;
          resolve();
        }, ms);
        const onAbort = (): void => pending?.();
        signal?.addEventListener("abort", onAbort, { once: true });
        pending = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          pending = undefined;
          resolve();
        };
      });
    },
    pullNow(): void {
      pending?.();
    },
  };
}

interface PollResult {
  readonly changed: boolean;
  readonly etag: string | null;
  readonly desiredState?: DesiredStateResponse;
}

/**
 * `GET /poll` with `If-None-Match`, handled directly with `fetch` rather
 * than `apiRequest` — a 304 is not JSON, and `apiRequest` always tries to
 * parse a body. `res.ok` is false for 304 too, so it's special-cased before
 * falling into the generic error path.
 */
async function pollDesiredState(
  bearerToken: string,
  previousEtag: string | null,
): Promise<PollResult> {
  const headers: Record<string, string> = { authorization: `Bearer ${bearerToken}` };
  if (previousEtag) headers["if-none-match"] = previousEtag;

  const res = await fetch(`${config.controlPlaneUrl}/api/v1/agent/poll`, { headers });
  if (res.status === 304) {
    return { changed: false, etag: previousEtag };
  }
  if (!res.ok) {
    throw new ApiError(res.status, await res.json().catch(() => undefined));
  }
  const desiredState = (await res.json()) as DesiredStateResponse;
  return { changed: true, etag: res.headers.get("etag"), desiredState };
}

async function reportObservedState(
  bearerToken: string,
  report: AgentReportRequest,
): Promise<AgentReportResponse> {
  const res = await fetch(`${config.controlPlaneUrl}/api/v1/agent/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` },
    body: JSON.stringify(report),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await res.json().catch(() => undefined));
  }
  return res.json() as Promise<AgentReportResponse>;
}

/**
 * The control agent's main loop (spec §8.1/§23): attest, poll desired
 * state, reconcile locally, report observed state, sleep ~30s, repeat. On
 * any failure it backs off with full jitter (see `backoff.ts`) instead of
 * retrying immediately or on a fixed schedule — that's the invariant that
 * keeps a fleet-wide control-plane outage from ending in a synchronised
 * thundering herd.
 *
 * Runs forever; `signal` is the only way out (used by tests).
 */
export async function runAgentLoop(options: { signal?: AbortSignal } = {}): Promise<never> {
  let attempt = 0;
  let lastEtag: string | null = null;
  const waker = makeWaker(options.signal);

  // Optional fast path (spec §8.1): wakes this loop's sleep the instant the control plane has
  // fresh desired state, instead of it always waiting out the full interval/backoff. Purely an
  // optimization — `getBearerToken` re-attesting on every (re)connect, and this loop polling on
  // a plain timer regardless, means a wake that never connects (or never arrives) changes
  // nothing but latency.
  //
  // Built via `URL`, not a `.replace(/^http/, "ws")` string hack — that regex is an unanchored,
  // case-sensitive 4-char prefix match, so it silently mangles a scheme-less host (matches
  // "http" inside a hostname, not just the protocol) or leaves a differently-cased scheme
  // untouched, either of which hands `connectWake` an invalid URL.
  const wakeUrl = new URL("/api/v1/agent/wake", config.controlPlaneUrl);
  wakeUrl.protocol = wakeUrl.protocol === "https:" ? "wss:" : "ws:";

  const wake = connectWake(
    wakeUrl.toString(),
    () => attest().then((session) => session.bearerToken),
    () => waker.pullNow(),
  );

  try {
    for (;;) {
      if (options.signal?.aborted) {
        throw new Error("agent loop aborted");
      }

      try {
        const session = await attest();

        const poll = await pollDesiredState(session.bearerToken, lastEtag);
        if (poll.changed) {
          lastEtag = poll.etag;
          console.log(
            `poll: desired state changed (version=${poll.desiredState?.version ?? "unknown"})`,
          );
          // Reconcile locally against `poll.desiredState` here once there's a real package
          // manifest to reconcile against (spec §8.1: "reconcile only closes gaps — it removes
          // undeclared software, never installs"). `poll.desiredState` is a stub today (see
          // docs/agents.md and this unit's PR description), so there's nothing to reconcile yet.
        }

        // Real observed state: `installedPackages`, `openPorts`, and `configState`
        // are all real scans now — `installed-packages.ts`/`open-ports.ts`/
        // `access-methods.ts` — not hardcoded placeholders. The three scans have
        // no data dependency on each other, so they run concurrently rather than
        // one after another.
        const [installedPackages, openPorts, runningAccessMethods] = await Promise.all([
          listInstalledPackages(),
          listOpenPorts(),
          listRunningAccessMethods(),
        ]);
        await reportObservedState(session.bearerToken, {
          agentVersion: AGENT_VERSION,
          observedAt: new Date().toISOString(),
          installedPackages,
          openPorts,
          configState: { runningAccessMethods },
        });

        attempt = 0;
        await waker.wait(POLL_INTERVAL_MS);
      } catch (error) {
        if (error instanceof AttestationRejectedError) {
          // Not transient — a bad join token doesn't become good on retry. Still backs off
          // rather than crash-looping, but logs loudly: this needs a human, not a retry.
          console.error(`attestation rejected: ${error.reason} — check MACHINE_TOKEN`);
        } else if (error instanceof ApiError && error.status === 401) {
          console.error("bearer session rejected by control plane — re-attesting next cycle");
          clearCachedSession();
        } else {
          console.error(`poll/report cycle failed: ${String(error)}`);
        }

        const delay = fullJitterBackoffMs(attempt, DEFAULT_BACKOFF);
        attempt += 1;
        console.log(`backing off ${Math.round(delay)}ms before retrying (attempt ${attempt})`);
        await waker.wait(delay);
      }
    }
  } finally {
    wake.close();
  }
}
