import { Context, Data, type Effect } from "effect";

export class ProvisioningError extends Data.TaggedError("ProvisioningError")<{
  reason: "quota_exceeded" | "region_unavailable" | "not_found" | "provider_error";
  cause?: unknown;
}> {}

export interface MachineDescriptor {
  machineId: string;
  orgId: string;
  region: string;
  sizeSku: string;
  /**
   * The declared package manifest to provision the machine with, as plain
   * entry strings (e.g. "docker", "nodejs 20" — see `docs/spec.md` §6).
   * Optional and provisional: real manifest resolution (org → template →
   * machine inheritance, pinning) lands with unit 2/5. Absent means "no
   * declared packages known yet".
   */
  packages?: ReadonlyArray<string>;
}

export interface MachineStatus {
  machineId: string;
  state: "provisioning" | "running" | "archived" | "missing" | "error";
  externalId: string | null;
  /**
   * Packages/software actually observed running on the machine as of this
   * status report. Undefined when the provider can't report package-level
   * detail. Reporting facts here must never itself decide what's out of
   * policy — comparing this against desired state to find undeclared
   * software is the reconciliation loop's job
   * (`src/reconcile/reconcile-machine.ts`), not this port's.
   */
  reportedPackages?: ReadonlyArray<string>;
}

/**
 * Port for provisioning cloud machines. `reconcile` only ever reports
 * status — per CLAUDE.md invariant #4 ("Reconcile only closes gaps. It
 * removes undeclared software, never installs.") and invariant #5 ("Drift
 * is flagged, never auto-corrected."), no implementation of this port
 * should install or correct anything from `reconcile`.
 */
export interface ProvisioningService {
  create(desc: MachineDescriptor): Effect.Effect<MachineStatus, ProvisioningError>;
  archive(machineId: string): Effect.Effect<MachineStatus, ProvisioningError>;
  reconcile(machineId: string): Effect.Effect<MachineStatus, ProvisioningError>;
}

export class ProvisioningServiceTag extends Context.Tag("ProvisioningService")<
  ProvisioningServiceTag,
  ProvisioningService
>() {}
