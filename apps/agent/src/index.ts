import { config } from "./config";

console.log(`cloudable-agent starting, control plane: ${config.controlPlaneUrl}`);
console.log("agent protocol (attest/poll/report/wake) not yet implemented — see docs/agents.md");
