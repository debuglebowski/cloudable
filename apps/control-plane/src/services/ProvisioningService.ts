import { Context, Data, type Effect } from "effect";

/**
 * Azure SDK failures arrive as `RestError`-shaped causes, where `statusCode` and `code`
 * (`404`, `AuthorizationFailed`, `Conflict`) are what actually identify the failure —
 * read defensively, the same way `ProvisioningService.azure.ts`'s `classifyAzureError`
 * reads them, rather than depending on a class from `@azure/core-rest-pipeline`.
 */
const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    const { code, statusCode } = cause as Error & { code?: unknown; statusCode?: unknown };
    const identifiers = [statusCode, code].filter((part) => part !== undefined).join(" ");
    return identifiers ? `${identifiers} ${cause.message}` : cause.message;
  }
  return String(cause);
};

export class ProvisioningError extends Data.TaggedError("ProvisioningError")<{
  reason: "quota_exceeded" | "region_unavailable" | "not_found" | "provider_error";
  cause?: unknown;
}> {
  /**
   * Without this, every renderer of this error prints the tag and nothing else:
   * `Cause.pretty` gives "ProvisioningError: An error has occurred" and `String(error)`
   * gives "ProvisioningError". Production hit exactly that — an archive failing at an
   * ARM call with no record anywhere of which call, or what Azure said. The fields that
   * make this error actionable belong in its message, so every log site gets them
   * without knowing anything about this type.
   */
  override get message(): string {
    return this.cause === undefined ? this.reason : `${this.reason}: ${describeCause(this.cause)}`;
  }
}

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
  /** The machine's current `externalResourceId` — reimage isn't a new logical
   * machine, so both finding the old VM to delete AND naming its replacement
   * reuse the identity this resolves to (see `ProvisioningService.azure.ts`'s
   * `resolveVmNames`), rather than minting a fresh name. No separate `name`
   * field: unlike `create`, nothing here needs to invent a brand-new name. */
  externalId: string | null;
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
 * since their descriptor already carries `provider`.
 *
 * `archive`/`reconcile`/`restart` take `externalId` (the machine's current
 * `externalResourceId`, `null` if not yet known) rather than a `name` — every
 * real call site already has the machine row loaded, same as `provider`
 * above. This used to be an optional `name?: string`, which the azure
 * adapter recomputed a resource name from (`namesFor`) to find the VM again.
 * That was a real, live footgun: two call sites (`reconcile-machine.ts`,
 * `domain/archive/archive.ts`) forgot to pass it, silently computing the
 * *wrong* name and 404ing against Azure — `reconcile-machine.ts`'s left the
 * whole reconcile loop permanently unable to promote any named Azure machine
 * out of "provisioning"; `archive.ts`'s was worse, since a 404 there is
 * treated as "already gone" and silently left the real VM running forever
 * while marking the machine archived. Recomputing a name from scratch at
 * every call site duplicates logic and has no compiler or runtime check that
 * it lands on the same name `create()` actually used. Looking up the stored
 * `externalResourceId` instead removes the guesswork entirely: it's the
 * exact resource Azure itself returned at creation, not a re-derived guess.
 * The azure adapter self-heals any row where it's still `null` (or wrong) by
 * querying Azure for the VM tagged `cloudable-machine-id` — see
 * `ProvisioningService.azure.ts`'s `resolveVmNames`.
 */
export interface ProvisioningService {
  create(desc: MachineDescriptor): Effect.Effect<MachineStatus, ProvisioningError>;
  archive(
    machineId: string,
    provider: Provider,
    externalId: string | null,
  ): Effect.Effect<MachineStatus, ProvisioningError>;
  reconcile(
    machineId: string,
    provider: Provider,
    externalId: string | null,
  ): Effect.Effect<MachineStatus, ProvisioningError>;
  reimage(desc: ReimageDescriptor): Effect.Effect<MachineStatus, ProvisioningError>;
  restart(
    machineId: string,
    provider: Provider,
    externalId: string | null,
  ): Effect.Effect<MachineStatus, ProvisioningError>;
}

export class ProvisioningServiceTag extends Context.Tag("ProvisioningService")<
  ProvisioningServiceTag,
  ProvisioningService
>() {}
