// ---------------------------------------------------------------------------
// `cloudable health` — is this control plane up, and is it the one I think it
// is. The only command that needs no session.
// ---------------------------------------------------------------------------
import { parseArgs, readSpec } from "./args";
import { config } from "./config";
import { apiRequest } from "./http-client";
import { printJson } from "./output";

export async function runHealthCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const health = await apiRequest<Record<string, unknown>>("/api/v1/health");
  if (args.booleans.has("json")) {
    printJson(health);
    return;
  }
  console.log(`${config.apiUrl} is up.`);
  for (const [key, value] of Object.entries(health)) {
    console.log(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
}
