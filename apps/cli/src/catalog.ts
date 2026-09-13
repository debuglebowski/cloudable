// ---------------------------------------------------------------------------
// `cloudable catalog *` and `cloudable capabilities` — what can be asked for,
// and what this deployment can actually provide.
//
// Two different questions. The catalog is the provider's own list of regions,
// images and sizes, synced into the control plane. Capabilities is about this
// deployment: Azure is only available if the control plane booted with a
// subscription configured, and `lockedRegion` means machines can land in
// exactly one region no matter what the catalog offers.
// ---------------------------------------------------------------------------
import { oneOf, parseArgs, readSpec, required } from "./args";
import { authenticatedApiRequest } from "./http-client";
import { dash, printEmpty, printFields, printJson, printTable } from "./output";

const KINDS = ["region", "image", "sku"] as const;

interface CatalogItem {
  code: string;
  displayName: string;
  vcpus: number | null;
  memoryGb: number | null;
  architecture: string | null;
}

interface Capabilities {
  azure: {
    available: boolean;
    subscriptionId: string | null;
    resourceGroup: string | null;
    lockedRegion: string | null;
  };
  docker: { available: boolean };
  fake: { available: boolean };
}

export async function runCatalogListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = `usage: cloudable catalog list ${KINDS.join("|")} [--provider azure]`;
  const args = parseArgs(argv, readSpec({ values: ["provider"] }));
  const kind = oneOf(required(args, 0, "a kind", usage), KINDS, "kind");
  const provider = oneOf(args.flags.provider ?? "azure", ["azure"] as const, "provider");

  const res = await authenticatedApiRequest<{ items: CatalogItem[] }>(
    `/api/v1/organisation/catalog/${provider}/${kind}`,
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.items.length === 0) {
    printEmpty(`${kind}s in the ${provider} catalog`);
    console.log("Sync it with `cloudable catalog sync regions` or `... sync sizes`.");
    return;
  }
  if (kind === "sku") {
    printTable(
      ["code", "vcpus", "memory", "arch", "name"],
      res.items.map((item) => [
        item.code,
        dash(item.vcpus),
        item.memoryGb === null ? dash(null) : `${item.memoryGb} GiB`,
        dash(item.architecture),
        item.displayName,
      ]),
    );
    return;
  }
  printTable(
    ["code", "arch", "name"],
    res.items.map((item) => [item.code, dash(item.architecture), item.displayName]),
  );
}

export async function runCatalogSyncCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = "usage: cloudable catalog sync regions|sizes";
  const args = parseArgs(argv, readSpec());
  const what = oneOf(required(args, 0, "regions or sizes", usage), ["regions", "sizes"], "kind");

  const res = await authenticatedApiRequest<{ items: CatalogItem[] }>(
    `/api/v1/organisation/catalog/azure/${what}/sync`,
    { method: "POST" },
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  console.log(`Synced ${res.items.length} ${what} from Azure.`);
}

export async function runCapabilitiesCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const caps = await authenticatedApiRequest<Capabilities>("/api/v1/provisioning/capabilities");
  if (args.booleans.has("json")) {
    printJson(caps);
    return;
  }
  printFields([
    ["azure", caps.azure.available ? "available" : "not configured"],
    ["azure subscription", dash(caps.azure.subscriptionId)],
    ["azure resource group", dash(caps.azure.resourceGroup)],
    ["azure region lock", dash(caps.azure.lockedRegion)],
    ["docker", caps.docker.available ? "available" : "not configured"],
    ["fake", caps.fake.available ? "available" : "not configured"],
  ]);
  if (caps.azure.lockedRegion) {
    console.log(
      `\nEvery machine lands in ${caps.azure.lockedRegion}; the subnet exists nowhere else.`,
    );
  }
}
