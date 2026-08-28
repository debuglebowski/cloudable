import { config } from "./config";
import { runAgentLoop } from "./poll-report-loop";

console.log(`cloudable-agent starting, control plane: ${config.controlPlaneUrl}`);

runAgentLoop().catch((error) => {
  console.error(`agent loop exited unexpectedly: ${String(error)}`);
  process.exit(1);
});
