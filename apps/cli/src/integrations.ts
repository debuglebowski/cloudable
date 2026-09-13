// ---------------------------------------------------------------------------
// `cloudable integrations *` — the identity provider, cloud subscriptions and
// secret stores this org has connected.
//
// No credential is ever stored here (invariant 1): what a connection holds is
// an identifier and non-secret config, with federation doing the rest. An
// integration the deployment's own configuration owns (an IdP from
// IDP_METADATA_URL) is reported as config-managed and cannot be disconnected
// through the API.
// ---------------------------------------------------------------------------
import { oneOf, parseArgs, readSpec, required, requiredFlag } from "./args";
import { CliError, EXIT } from "./errors";
import { authenticatedApiRequest, postJson } from "./http-client";
import { dash, printEmpty, printFields, printJson, printTable, shortTime } from "./output";
import { usageFor } from "./program";

const KINDS = ["idp", "cloud", "secret_store"] as const;
const PROVIDERS = ["azure", "docker", "fake"] as const;

interface Integration {
  id: string;
  orgId: string;
  kind: (typeof KINDS)[number];
  provider: (typeof PROVIDERS)[number] | null;
  identifier: string;
  connectedAt: string;
  removedAt: string | null;
  config: Record<string, unknown>;
  managedByConfig: boolean;
}

export async function runIntegrationsListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const res = await authenticatedApiRequest<{ items: Integration[] }>("/api/v1/integrations");
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.items.length === 0) {
    printEmpty("integrations");
    return;
  }
  printTable(
    ["id", "kind", "provider", "identifier", "connected", "managed by"],
    res.items.map((item) => [
      item.id,
      item.kind,
      dash(item.provider),
      item.identifier,
      shortTime(item.connectedAt),
      item.managedByConfig ? "deployment config" : "this org",
    ]),
  );
}

export async function runIntegrationsConnectCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = usageFor(
    `integrations connect --kind ${KINDS.join("|")} --identifier <identifier> [--provider ${PROVIDERS.join("|")}] [--config <json>]`,
  );
  const args = parseArgs(argv, readSpec({ values: ["kind", "identifier", "provider", "config"] }));
  const kind = oneOf(requiredFlag(args, "kind", usage), KINDS, "kind");
  const identifier = requiredFlag(args, "identifier", usage);

  let config: Record<string, unknown> = {};
  if (args.flags.config) {
    try {
      config = JSON.parse(args.flags.config) as Record<string, unknown>;
    } catch (cause) {
      throw new CliError(
        `--config is not valid JSON.\n\n${cause instanceof Error ? cause.message : String(cause)}`,
        EXIT.usage,
      );
    }
  }

  const integration = await authenticatedApiRequest<Integration>(
    "/api/v1/integrations",
    postJson({
      kind,
      identifier,
      config,
      ...(args.flags.provider
        ? { provider: oneOf(args.flags.provider, PROVIDERS, "provider") }
        : {}),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(integration);
    return;
  }
  printFields([
    ["id", integration.id],
    ["kind", integration.kind],
    ["provider", dash(integration.provider)],
    ["identifier", integration.identifier],
    ["connected", shortTime(integration.connectedAt)],
  ]);
}

export async function runIntegrationsDisconnectCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = required(args, 0, "an integration id", usageFor("integrations disconnect <id>"));
  await authenticatedApiRequest<{ ok: true }>(
    `/api/v1/integrations/${id}/disconnect`,
    postJson({}),
  );
  console.log(`Disconnected ${id}.`);
}
