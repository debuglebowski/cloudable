import { config } from "./config";
import { runAgentLoop } from "./poll-report-loop";
import { maybeStartManualTunnelSession } from "./tunnel/client";

console.log(`cloudable-agent starting, control plane: ${config.controlPlaneUrl}`);

// Dev/test-only manual trigger — no-op unless TUNNEL_ATTACH_URL/TUNNEL_SESSION_TOKEN are set.
// See `tunnel/client.ts`'s doc comment.
maybeStartManualTunnelSession();

runAgentLoop().catch((error) => {
  console.error(`agent loop exited unexpectedly: ${String(error)}`);
  process.exit(1);
});
