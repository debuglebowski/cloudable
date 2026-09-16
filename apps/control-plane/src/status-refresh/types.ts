import type { MachineStatus } from "../services/ProvisioningService";

/**
 * What this pass needs to know about a machine to re-observe it.
 *
 * No package manifest here any more. This loop used to carry desired state and
 * diff it against what the provider reported, which is where drift detection
 * lived; packages are now permission plus explicit per-package actions, so the
 * only question left is "what state is this machine actually in".
 */
export interface DesiredMachineState {
  machineId: string;
  orgId: string;
  provider: "azure" | "docker" | "fake";
  region: string | null;
  sizeSku: string;
  /**
   * Whether the machine should exist right now. There is no "deleted"
   * state — machines are archived, never deleted.
   */
  lifecycle: "live" | "archived";
}

/** What `refreshMachineStatus` did, and what it observed while doing it. */
export type RefreshAction =
  | { kind: "created"; status: MachineStatus }
  | { kind: "archived"; status: MachineStatus }
  | { kind: "already_archived"; status: MachineStatus }
  | { kind: "observed"; status: MachineStatus };

export interface RefreshMachineResult {
  machineId: string;
  action: RefreshAction;
}
