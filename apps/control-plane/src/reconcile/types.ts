import type { MachineStatus } from "../services/ProvisioningService";

/**
 * A machine's desired state, as the reconciliation loop needs to see it.
 *
 * Provisional shape: the real package manifest (org → template → machine
 * inheritance, pinning) is unit 2/5's job — see `docs/inheritance.md`.
 * Until that lands, `packages` is a flat list of
 * manifest entry strings exactly as declared (e.g. "docker", "nodejs 20").
 */
export interface DesiredMachineState {
  machineId: string;
  orgId: string;
  region: string;
  sizeSku: string;
  /** Declared package manifest entries. Provisional — see above. */
  packages: ReadonlyArray<string>;
  /**
   * Whether the machine should exist right now. There is no "deleted"
   * state — machines are archived, never deleted.
   */
  lifecycle: "live" | "archived";
}

/** What `reconcileMachine` did, and what it observed while doing it. */
export type ReconcileAction =
  | { kind: "created"; status: MachineStatus }
  | { kind: "archived"; status: MachineStatus }
  | { kind: "already_archived"; status: MachineStatus }
  | { kind: "in_sync"; status: MachineStatus }
  | {
      /**
       * Reconcile observed packages running on the machine that aren't in
       * the declared manifest. Per invariants #4 and #5, this is a report
       * only — nothing is installed, and nothing is removed to correct it.
       */
      kind: "drifted";
      status: MachineStatus;
      undeclaredPackages: ReadonlyArray<string>;
    };

export interface ReconcileMachineResult {
  machineId: string;
  action: ReconcileAction;
}
