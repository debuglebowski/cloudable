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
}

export interface MachineStatus {
  machineId: string;
  state: "provisioning" | "running" | "archived" | "missing" | "error";
  externalId: string | null;
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
