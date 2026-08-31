import { config } from "./config";
import { runAgentLoop } from "./poll-report-loop";
import { maybeStartManualTunnelSession } from "./tunnel/client";
import { runTunnelSignalLoop } from "./tunnel/signal-listener";

console.log(`cloudable-agent starting, control plane: ${config.controlPlaneUrl}`);

// Dev/test-only manual trigger — no-op unless TUNNEL_ATTACH_URL, TUNNEL_SESSION_TOKEN, AND
// TUNNEL_MANUAL_TRIGGER_ACK are all set (see `tunnel/client.ts`'s doc comment for why three,
// not two). `tunnelController` is `undefined` in the (overwhelmingly common) no-op case.
const tunnelController = maybeStartManualTunnelSession();

runAgentLoop().catch((error) => {
  console.error(`agent loop exited unexpectedly: ${String(error)}`);
  // Kill any active manual tunnel session's PTY/socket before this process disappears — an
  // abrupt `process.exit()` otherwise leaves a spawned shell orphaned rather than terminated.
  tunnelController?.abort();
  process.exit(1);
});

// The tunnel-signal listener runs as its own independent long-poll loop, concurrently with
// the ~30s poll/report cycle above — see tunnel/signal-listener.ts's header comment for why
// this is a separate channel from `wake`. Still logs rather than acting on a signal:
// `tunnel/client.ts`'s `runTunnelSession` (which actually verifies a session token and opens
// the reverse tunnel) now exists, but the signal payload here is only a bare `sessionId` — it
// carries no attach URL or session token for `runTunnelSession` to use, so there is not yet
// enough information at this call site to open a real connection from a signal alone. Wiring
// that up (e.g. a control-plane lookup by `sessionId`, or extending the signal payload itself)
// is a real follow-up, not done by this commit. Until then, this loop's job is just to prove
// the signal itself reaches this process — see test/agent-connectivity/.
runTunnelSignalLoop({
  onSessionWaiting: (sessionId) =>
    console.log(`tunnel-signal: session ${sessionId} waiting — connect now`),
  onSessionTerminate: (sessionId) => console.log(`tunnel-signal: session ${sessionId} terminate`),
}).catch((error) => {
  console.error(`tunnel signal loop exited unexpectedly: ${String(error)}`);
  process.exit(1);
});
