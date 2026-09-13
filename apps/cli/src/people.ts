// ---------------------------------------------------------------------------
// `cloudable people *` and `cloudable offboard *`.
//
// People are editable here only while no SCIM source owns them: the API
// refuses to edit a `scim`-sourced row, and that refusal is surfaced as-is
// rather than worked around. Offboarding is an approval-gated sequence over
// every machine the person owns, so it reports per-machine outcomes.
// ---------------------------------------------------------------------------
import { parseArgs, patchable, readSpec, required, requiredFlag } from "./args";
import { UsageError } from "./errors";
import { authenticatedApiRequest, patchJson, postJson } from "./http-client";
import { type PersonWire, listPeople } from "./identity";
import { printEmpty, printFields, printJson, printTable, shortTime } from "./output";
import { personId } from "./resolve";

interface OffboardResult {
  approvalId: string;
  status: "approved" | "pending" | "rejected" | "expired";
  machinesOffboarded: ReadonlyArray<string>;
  machineFailures: ReadonlyArray<{ machineId: string; reason: string }>;
}

function printPerson(person: PersonWire): void {
  printFields([
    ["id", person.id],
    ["email", person.email],
    ["role", person.role],
    ["source", person.source],
    ["active", person.active ? "yes" : "no"],
    ["created", shortTime(person.createdAt)],
    ["deactivated", shortTime(person.deactivatedAt)],
  ]);
}

export async function runPeopleListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const people = await listPeople();
  if (args.booleans.has("json")) {
    printJson({ items: people });
    return;
  }
  if (people.length === 0) {
    printEmpty("people");
    return;
  }
  printTable(
    ["id", "email", "role", "source", "active"],
    people.map((p) => [p.id, p.email, p.role, p.source, p.active ? "yes" : "no"]),
  );
}

export async function runPeopleCreateCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = "usage: cloudable people create --email <email> --role <role>";
  const args = parseArgs(argv, readSpec({ values: ["email", "role"] }));
  const person = await authenticatedApiRequest<PersonWire>(
    "/api/v1/people",
    postJson({
      email: requiredFlag(args, "email", usage),
      role: requiredFlag(args, "role", usage),
    }),
  );
  if (args.booleans.has("json")) {
    printJson(person);
    return;
  }
  printPerson(person);
}

export async function runPeopleUpdateCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = "usage: cloudable people update <email|id> [--email <email>] [--role <role>]";
  const args = parseArgs(argv, readSpec({ values: ["email", "role"] }));
  const id = await personId(required(args, 0, "a person", usage));
  const payload = patchable(args, ["email", "role"]);
  if (Object.keys(payload).length === 0) throw new UsageError(`nothing to change\n\n${usage}`);

  const person = await authenticatedApiRequest<PersonWire>(
    `/api/v1/people/${id}`,
    patchJson(payload),
  );
  if (args.booleans.has("json")) {
    printJson(person);
    return;
  }
  printPerson(person);
}

async function setActive(argv: ReadonlyArray<string>, active: boolean): Promise<void> {
  const verb = active ? "activate" : "deactivate";
  const args = parseArgs(argv, readSpec());
  const id = await personId(
    required(args, 0, "a person", `usage: cloudable people ${verb} <email|id>`),
  );
  const person = await authenticatedApiRequest<PersonWire>(
    `/api/v1/people/${id}/active`,
    patchJson({ active }),
  );
  if (args.booleans.has("json")) {
    printJson(person);
    return;
  }
  console.log(`${person.email} is now ${person.active ? "active" : "inactive"}.`);
  if (!active) {
    console.log(
      "Deactivating does not archive their machines. Use `cloudable offboard start` for that.",
    );
  }
}

export const runPeopleActivateCommand = (argv: ReadonlyArray<string>) => setActive(argv, true);
export const runPeopleDeactivateCommand = (argv: ReadonlyArray<string>) => setActive(argv, false);

function printOffboard(result: OffboardResult): void {
  printFields([
    ["approval", result.approvalId],
    ["status", result.status],
    [
      "machines archived",
      result.machinesOffboarded.length === 0 ? "none" : result.machinesOffboarded.join(", "),
    ],
  ]);
  if (result.machineFailures.length > 0) {
    console.log("\nfailed partway:");
    printTable(
      ["machine", "reason"],
      result.machineFailures.map((f) => [f.machineId, f.reason]),
    );
  }
  if (result.status !== "approved") {
    console.log(
      `\nNothing ran yet. Once the approval is decided, run \`cloudable offboard sync ${result.approvalId}\`.`,
    );
  }
}

export async function runOffboardStartCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = "usage: cloudable offboard start <email|id> --reason <reason>";
  const args = parseArgs(argv, readSpec({ values: ["reason"] }));
  const target = await personId(required(args, 0, "a person", usage));
  const result = await authenticatedApiRequest<OffboardResult>(
    "/api/v1/offboarding",
    postJson({ personId: target, reason: requiredFlag(args, "reason", usage) }),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }
  printOffboard(result);
}

export async function runOffboardSyncCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const approvalId = required(
    args,
    0,
    "an approval id",
    "usage: cloudable offboard sync <approvalId>",
  );
  const result = await authenticatedApiRequest<OffboardResult>(
    `/api/v1/offboarding/${approvalId}/sync`,
    postJson({}),
  );
  if (args.booleans.has("json")) {
    printJson(result);
    return;
  }
  printOffboard(result);
}
