import { AttestationRejectedError, attest, clearCachedSession } from "./attestation";
import { DEFAULT_BACKOFF, fullJitterBackoffMs } from "./backoff";
import { config } from "./config";
import { ApiError } from "./http-client";
import type { AgentReportRequest, AgentReportResponse, DesiredStateResponse } from "./wire-types";

// TODO(build tooling): inject the real build version instead of hardcoding it.
const AGENT_VERSION = "0.0.0";

const POLL_INTERVAL_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

      // Observed-state gathering is a stub for the same reason — see docs/agents.md.
      await reportObservedState(session.bearerToken, {
        agentVersion: AGENT_VERSION,
        observedAt: new Date().toISOString(),
        installedPackages: [],
        openPorts: [],
      });

      attempt = 0;
      await sleep(POLL_INTERVAL_MS);
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
      await sleep(delay);
    }
  }
}
