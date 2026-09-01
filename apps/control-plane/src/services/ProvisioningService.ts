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
   * The machine's declared OS image (e.g. "ubuntu-22.04"). Optional: the
   * reconcile loop's `DesiredMachineState` (`reconcile/types.ts`) has no
   * image field yet (unwired, provisional — see that file), so this can't
   * be required without rippling into that unrelated, still-dead code
   * path. `MachineService.create` (the real, wired caller) always supplies
   * it.
   */
  image?: string;
  /**
   * The declared package manifest to provision the machine with, as plain
   * entry strings (e.g. "docker", "nodejs 20" — see `docs/spec.md` §6).
   * Resolved from the org → template → machine manifest chain at creation
   * time (see `MachineService.create`) — a brand-new machine has no
   * machine-level overrides yet, so this is the org (+ template) manifest.
   */
  packages?: ReadonlyArray<string>;
}

/**
 * Unit 18 (upgrade transactionality) addition — see that file header comment
 * in `ProvisioningService.fake.ts` / the PR description for why a fourth
 * port method was added instead of composing `archive` + `create`.
 */
export interface ReimageDescriptor {
  machineId: string;
  orgId: string;
  region: string;
  sizeSku: string;
  targetImage: string;
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
 *
 * `reimage` (added by unit 18): "OS upgrade is: reimage, remount persistent
 * volume, reinstall declared packages" (spec §7). Modeled as its own method
 * rather than `archive` + `create` because `archive` carries archive-lifecycle
 * semantics (retention clock, `machine.archived`, offboarding sub-states —
 * see CLAUDE.md invariant #6) that don't apply to an in-place OS upgrade of a
 * still-owned, still-live machine. This changes a shared interface — every
 * implementation (`.fake.ts`, `.azure.ts`) is updated alongside it.
 */
export interface ProvisioningService {
  create(desc: MachineDescriptor): Effect.Effect<MachineStatus, ProvisioningError>;
  archive(machineId: string): Effect.Effect<MachineStatus, ProvisioningError>;
  reconcile(machineId: string): Effect.Effect<MachineStatus, ProvisioningError>;
  reimage(desc: ReimageDescriptor): Effect.Effect<MachineStatus, ProvisioningError>;
}

export class ProvisioningServiceTag extends Context.Tag("ProvisioningService")<
  ProvisioningServiceTag,
  ProvisioningService
>() {}
