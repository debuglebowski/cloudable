// ---------------------------------------------------------------------------
// `cloudable elevation *` — asking for access to a machine you do not own,
// and giving it back.
//
// An elevation is a request plus an approval, never a bypass: the request is
// recorded, the approval is decided elsewhere (`cloudable approvals decide`),
// and the grant expires on its own. `sync` exists because deciding an approval
// does not call back into the elevation — see `domain/elevation`.
// ---------------------------------------------------------------------------
import { oneOf, parseArgs, readSpec, required, requiredFlag } from "./args";
import { authenticatedApiRequest, postJson } from "./http-client";
import { dash, printEmpty, printFields, printJson, printTable, shortTime } from "./output";
import { machineId } from "./resolve";

type ElevationLevel = "file_recovery" | "shell";
type ElevationStatus = "requested" | "granted" | "expired" | "denied";

interface Elevation {
  id: string;
  orgId: string;
  personId: string;
  machineId: string;
  level: ElevationLevel;
  reason: string;
  approvalId: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  status: ElevationStatus;
}

interface ElevationListItem {
  id: string;
  personId: string;
  machineId: string;
  machineName: string;
  level: ElevationLevel;
  reason: string;
  status: ElevationStatus;
  expiresAt: string | null;
}

function printElevation(elevation: Elevation): void {
  printFields([
    ["id", elevation.id],
    ["status", elevation.status],
    ["level", elevation.level],
    ["machine", elevation.machineId],
    ["person", elevation.personId],
    ["reason", elevation.reason],
    ["approval", dash(elevation.approvalId)],
    ["granted", shortTime(elevation.grantedAt)],
    ["expires", shortTime(elevation.expiresAt)],
  ]);
}

export async function runElevationRequestCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage =
    "usage: cloudable elevation request --machine <machine> --level file_recovery|shell --reason <reason>";
  const args = parseArgs(argv, readSpec({ values: ["machine", "level", "reason"] }));
  const level = oneOf(
    requiredFlag(args, "level", usage),
    ["file_recovery", "shell"] as const,
    "level",
  );
  const id = await machineId(requiredFlag(args, "machine", usage));

  const elevation = await authenticatedApiRequest<Elevation>(
    "/api/v1/elevations",
    postJson({ machineId: id, level, reason: requiredFlag(args, "reason", usage) }),
  );
  if (args.booleans.has("json")) {
    printJson(elevation);
    return;
  }
  printElevation(elevation);
  if (elevation.status === "requested") {
    console.log("\nWaiting on approval. Run `cloudable elevation sync <id>` once it is decided.");
  }
}

export async function runElevationListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const res = await authenticatedApiRequest<{ elevations: ElevationListItem[] }>(
    "/api/v1/elevations",
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.elevations.length === 0) {
    printEmpty("elevations");
    return;
  }
  printTable(
    ["id", "machine", "level", "status", "expires", "reason"],
    res.elevations.map((e) => [
      e.id,
      e.machineName,
      e.level,
      e.status,
      shortTime(e.expiresAt),
      e.reason,
    ]),
  );
}

async function elevationAction(
  argv: ReadonlyArray<string>,
  verb: "get" | "sync" | "expire",
): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const id = required(args, 0, "an elevation id", `usage: cloudable elevation ${verb} <id>`);
  const path = verb === "get" ? `/api/v1/elevations/${id}` : `/api/v1/elevations/${id}/${verb}`;
  const elevation = await authenticatedApiRequest<Elevation>(
    path,
    verb === "get" ? undefined : postJson({}),
  );
  if (args.booleans.has("json")) {
    printJson(elevation);
    return;
  }
  printElevation(elevation);
}

export const runElevationGetCommand = (argv: ReadonlyArray<string>) => elevationAction(argv, "get");
export const runElevationSyncCommand = (argv: ReadonlyArray<string>) =>
  elevationAction(argv, "sync");
export const runElevationExpireCommand = (argv: ReadonlyArray<string>) =>
  elevationAction(argv, "expire");
