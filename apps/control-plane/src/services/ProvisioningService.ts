import { Context, Data, type Effect } from "effect";

export class ProvisioningError extends Data.TaggedError("ProvisioningError")<{
  reason: "quota_exceeded" | "region_unavailable" | "not_found" | "provider_error";
  cause?: unknown;
}> {}

/** Which backend a call dispatches to — see `ProvisioningService.switchable.ts`. */
export type Provider = "azure" | "docker" | "fake";

export interface MachineDescriptor {
  machineId: string;
  orgId: string;
  provider: Provider;
  /** `null` for providers with no region concept (docker/fake) — only `azure` reads this. */
  region: string | null;
  sizeSku: string;
  /**
   * Human-readable label — feeds a readable prefix onto the real Azure
   * resource names (`ProvisioningService.azure.ts`'s `namesFor`) when
   * present. Optional for the same reason `image` below is: the reconcile
   * loop's `DesiredMachineState` (`reconcile/types.ts`) has no name field
   * yet — the real, wired caller (`MachineService.create`) always supplies
   * it.
   */
  name?: string;
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
   * entry strings (e.g. "docker", "nodejs 20").
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
  provider: Provider;
  region: string | null;
  sizeSku: string;
  targetImage: string;
  /** Same optional readable-name field as `MachineDescriptor.name` — reimage
   * recreates the VM under the same resource names `create` used, so this
   * needs to be the machine's current name for the azure adapter's `namesFor`
   * call to land on the same names again. */
  name?: string;
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
 * status — reconcile only closes gaps, removing undeclared software but
 * never installing, and drift is flagged, never auto-corrected, so no
 * implementation of this port should install or correct anything from
 * `reconcile`.
 *
 * `reimage` (added by unit 18): OS upgrade is reimage, remount persistent
 * volume, reinstall declared packages. Modeled as its own method
 * rather than `archive` + `create` because `archive` carries archive-lifecycle
 * semantics (retention clock, `machine.archived`, offboarding sub-states)
 * that don't apply to an in-place OS upgrade of a
 * still-owned, still-live machine. This changes a shared interface — every
 * implementation (`.fake.ts`, `.azure.ts`) is updated alongside it.
 *
 * `restart`: reboots the underlying compute in place — same still-owned,
 * still-live machine, same identity/attestation, just the running process
 * cycled. Modeled as its own method for the same reason `reimage` is: not
 * `archive` + `create` (that's destroy + recreate, a much bigger operation
 * that would also mint a fresh attestation identity for no reason here).
 *
 * `archive`/`reconcile`/`restart` take `provider` explicitly rather than
 * looking it up themselves — every real call site already has the machine
 * row loaded (it needs it for other reasons anyway), so this keeps
 * `ProvisioningService.switchable.ts`'s dispatcher a pure closure with no DB
 * dependency of its own. `create`/`reimage` don't need a separate parameter
 * since their descriptor already carries `provider`. `name` (optional,
 * added alongside the readable-Azure-naming change) follows the same
 * reasoning: the azure adapter needs the machine's current name to
 * reconstruct the same resource names `create` used, and every real call
 * site already has it in hand too. `reconcile-machine.ts`'s still-provisional
 * reconcile-loop path (whose `DesiredMachineState` has no name field, same
 * as it has no `image` field) is the one caller that omits it — same
 * fallback-to-id-only-naming behavior that already existed before this
 * field was added.
 */
export interface ProvisioningService {
  create(desc: MachineDescriptor): Effect.Effect<MachineStatus, ProvisioningError>;
  archive(
    machineId: string,
    provider: Provider,
    name?: string,
  ): Effect.Effect<MachineStatus, ProvisioningError>;
  reconcile(
    machineId: string,
    provider: Provider,
    name?: string,
  ): Effect.Effect<MachineStatus, ProvisioningError>;
  reimage(desc: ReimageDescriptor): Effect.Effect<MachineStatus, ProvisioningError>;
  restart(
    machineId: string,
    provider: Provider,
    name?: string,
  ): Effect.Effect<MachineStatus, ProvisioningError>;
}

export class ProvisioningServiceTag extends Context.Tag("ProvisioningService")<
  ProvisioningServiceTag,
  ProvisioningService
>() {}
