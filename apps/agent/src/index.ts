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
// this is a separate channel from `wake`. Still logs rather than acting on a signal: the real
// reverse-tunnel implementation is the separate `apps/tunnel-daemon` binary (its own
// persistent outbound connection + PTY session manager, not this process) — this loop's job
// is just to prove the signal itself reaches the agent — see test/agent-connectivity/.
runTunnelSignalLoop({
  onSessionWaiting: (sessionId) =>
    console.log(`tunnel-signal: session ${sessionId} waiting — connect now`),
  onSessionTerminate: (sessionId) => console.log(`tunnel-signal: session ${sessionId} terminate`),
}).catch((error) => {
  console.error(`tunnel signal loop exited unexpectedly: ${String(error)}`);
  process.exit(1);
});
