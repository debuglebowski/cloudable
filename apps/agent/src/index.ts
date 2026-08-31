import { config } from "./config";
import { runAgentLoop } from "./poll-report-loop";
import { maybeStartManualTunnelSession } from "./tunnel/client";

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
