import { config } from "./config";
import { runAgentLoop } from "./poll-report-loop";
import { runTunnelSignalLoop } from "./tunnel/signal-listener";

console.log(`cloudable-agent starting, control plane: ${config.controlPlaneUrl}`);

runAgentLoop().catch((error) => {
  console.error(`agent loop exited unexpectedly: ${String(error)}`);
  process.exit(1);
});

// The tunnel-signal listener runs as its own independent long-poll loop, concurrently with
// the ~30s poll/report cycle above — see tunnel/signal-listener.ts's header comment for why
// this is a separate channel from `wake`. Logs rather than acting on a signal for now:
// apps/agent/src/tunnel/client.ts (a sibling unit, not yet merged) is what actually verifies
// the session token and opens the reverse tunnel; once it lands, its `connect`/`disconnect`
// methods replace these two log-only callbacks. Until then, this loop's job is just to prove
// the signal itself reaches this process — see test/agent-connectivity/.
runTunnelSignalLoop({
  onSessionWaiting: (sessionId) =>
    console.log(`tunnel-signal: session ${sessionId} waiting — connect now`),
  onSessionTerminate: (sessionId) => console.log(`tunnel-signal: session ${sessionId} terminate`),
}).catch((error) => {
  console.error(`tunnel signal loop exited unexpectedly: ${String(error)}`);
  process.exit(1);
});
