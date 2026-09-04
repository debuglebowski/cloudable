// ---------------------------------------------------------------------------
// `cloudable machines list` / `cloudable machines reconcile <id>` — real
// calls against the same session-authenticated endpoints the console uses
// (`http/routes/machines.ts`, `http/routes/config.ts`'s reconcile trigger).
// Requires `cloudable auth login` first — see `auth.ts`/`session.ts`.
// ---------------------------------------------------------------------------
import type {
  ListMachinesResponse,
  MachineState,
  ReconcileTriggerResponse,
} from "@cloudable/contracts";
import { authenticatedApiRequest } from "./http-client";

const STATE_LABEL: Record<MachineState, string> = {
  provisioning: "provisioning",
  running: "running",
  stopped: "stopped",
  archived_restorable: "archived (restorable)",
  archived_expired: "archived (expired)",
  error: "error",
};

export async function listMachines(): Promise<ListMachinesResponse["items"]> {
  const res = await authenticatedApiRequest<ListMachinesResponse>("/api/v1/machines");
  return res.items;
}

export async function runMachinesListCommand(): Promise<void> {
  const machines = await listMachines();
  if (machines.length === 0) {
    console.log("No machines.");
    return;
  }
  const nameWidth = Math.max(4, ...machines.map((m) => m.name.length));
  console.log(`${"NAME".padEnd(nameWidth)}  STATE                 REGION      IMAGE`);
  for (const m of machines) {
    console.log(
      `${m.name.padEnd(nameWidth)}  ${STATE_LABEL[m.state].padEnd(20)}  ${(m.region ?? "—").padEnd(10)}  ${m.image}`,
    );
  }
}

export async function triggerReconcile(machineId: string): Promise<ReconcileTriggerResponse> {
  return authenticatedApiRequest<ReconcileTriggerResponse>(
    `/api/v1/config/machines/${machineId}/reconcile`,
    { method: "POST", body: JSON.stringify({ confirm: true }) },
  );
}

export async function runMachinesReconcileCommand(argv: ReadonlyArray<string>): Promise<void> {
  const machineId = argv[0];
  if (!machineId) {
    throw new Error("usage: cloudable machines reconcile <machineId>");
  }
  const result = await triggerReconcile(machineId);
  console.log(
    `Desired state for ${result.machineId} is now version ${result.desiredStateVersion}. The agent applies it on its next poll (~30s) — not instantly.`,
  );
}

export async function runMachinesCommand(argv: ReadonlyArray<string>): Promise<void> {
  const subcommand = argv[0];
  if (subcommand === "list") {
    await runMachinesListCommand();
  } else if (subcommand === "reconcile") {
    await runMachinesReconcileCommand(argv.slice(1));
  } else {
    console.log("usage: cloudable machines <list|reconcile>");
  }
}
