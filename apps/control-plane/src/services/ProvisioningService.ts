import type { CapturedDisk } from "@cloudable/schema";
import { Context, Data, type Effect } from "effect";

export type { CapturedDisk };

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
  /**
   * A snapshot's captured DATA disk (`CapturedDisk.externalId`, a full ARM snapshot
   * resource id) to build this machine's data disk from, instead of an empty one.
   *
   * This is how "restore into a new machine" works: the machine is created normally —
   * same catalog validation, same fresh OS from `image`, same new identity — and only
   * `/home` comes from the snapshot. The OS disk is NEVER cloned, so a restored machine
   * inherits no host keys or on-disk identity from the one it came from.
   *
   * Nothing else in the guest needs to change: `homeVolumeSection` skips `mkfs` when
   * `blkid` finds a filesystem, reads the `.cloudable-home-volume` marker, and adopts the
   * disk's own uid/gid — logic written for reimage that covers this unchanged.
   */
  dataDiskSourceSnapshotId?: string;
}

/**
 * Unit 18 (upgrade transactionality) addition — see that file header comment
 * in `ProvisioningService.fake.ts` / the PR description for why a fourth
 * port method was added instead of composing `archive` + `create`.
 */
/**
 * Overwrite an EXISTING machine's data disk with a copy of a snapshot's, and bring the
 * machine back on a fresh OS disk from `image`.
 *
 * Distinct from `MachineDescriptor.dataDiskSourceSnapshotId`, which builds a brand-new
 * machine: this one targets a machine that already has a row, and may or may not still
 * have infrastructure — a live machine has all of it, one that `archive()` tore down has
 * none. The adapter probes rather than being told which, deliberately: `machines.state`
 * and provider reality demonstrably disagree (see this adapter's own note on the
 * 2026-09-12 incident where a row read archived while its VM was still running), and a
 * caller-side branch on state would reconfigure a live machine's OS disk.
 */
export interface RestoreDataDiskDescriptor {
  machineId: string;
  orgId: string;
  provider: Provider;
  region: string | null;
  sizeSku: string;
  /** The machine's own DECLARED image (`machines.image`). Never the snapshot's OS — that
   * is not cloned here, ever. */
  image: string;
  /** Required in practice, optional only to match `MachineDescriptor`. A machine whose
   * infrastructure `archive()` deleted has no VM left to resolve names from, so its
   * replacement is named by `namesFor(machineId, name)` — omitting it takes the id-only
   * branch and silently renames every resource of a revived machine. */
  name?: string;
  /** Accepted for symmetry with `MachineDescriptor`, and normally omitted: cloud-init
   * puts these in `CLOUDABLE_PACKAGES` on the agent's systemd unit, which nothing reads,
   * and the manifest is a permission list that nothing converges a machine towards
   * (invariant 4). A restored machine installs nothing on boot. */
  packages?: ReadonlyArray<string>;
  /** The machine's current `externalResourceId`, `null` if unknown — same contract and
   * same tag-based self-healing as `archive`/`reconcile`/`restart`/`reimage`. */
  externalId: string | null;
  /** `CapturedDisk.externalId` of the snapshot's `kind: "data"` entry. Exactly one disk;
   * an `os` entry is never read here.
   *
   * No size or region passed alongside it, deliberately: the adapter reads both off the
   * snapshot resource itself before it destroys anything. `capturedDisks[].sizeBytes` is
   * the PROVISIONED size of the source disk and can exceed this build's default, and a
   * size taken from the row is a re-derivation nothing re-checks. */
  dataDiskSnapshotId: string;
}

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
  /**
   * `stopped` is a machine that is deliberately off, not a fault. `machines.state`
   * has carried that value since the schema was written and the console has a badge
   * for it, but no adapter ever produced it: the azure adapter reported every power
   * state other than `running` as `error`, so a deallocated machine showed up in the
   * console as "Error — provider reconcile reported state error". Observed in
   * production on 2026-09-12, on machines a failed archive had deallocated.
   */
  state: "provisioning" | "running" | "stopped" | "archived" | "missing" | "error";
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
/** Which disks a snapshot captures — mirrors `snapshots.scope` in `packages/schema`.
 *
 * Deliberately NOT the same vocabulary as `snapshot.restored`'s `mode`
 * ("data" | "config" | "full"), which is what a RESTORE writes back. This is what the
 * snapshot CAPTURED. They share the word "full" and mean different things: a "shallow"
 * snapshot can never serve a "full"-mode restore, because there is no OS disk in it. */
export type SnapshotScope = "full" | "shallow";

export interface SnapshotDescriptor {
  machineId: string;
  provider: Provider;
  externalId: string | null;
  scope: SnapshotScope;
  /**
   * The id of the snapshot row this capture belongs to, minted by the caller before the
   * provider is called so the provider can put it in the resource name.
   *
   * Without it the azure adapter named every snapshot `<disk>-snap`, which is the same
   * name every time for a given machine — so a machine's second snapshot silently
   * overwrote its first via beginCreateOrUpdate. Observed on 2026-09-15: an upgrade
   * snapshot and an archive snapshot twenty minutes apart left two rows in the database
   * pointing at one pair of Azure resources. The deterministic name was survivable only
   * while nothing recorded ids; now that `CapturedDisk.externalId` is written down, the
   * name does not need to be derivable and must instead be unique.
   */
  snapshotId: string;
  /**
   * Stop the machine before copying its disks.
   *
   * An archive can afford this and gets a clean, quiesced copy for it. An upgrade
   * cannot — the machine has to stay up until `reimage` replaces it — so its
   * pre-upgrade snapshot is crash-consistent: the same guarantee as pulling the power
   * cord. ext4 journals, so it recovers, but it is not equivalent to a quiesced copy.
   * Explicit at the call site rather than buried in an adapter, because it is the kind
   * of difference someone needs to know about when a restore comes out unclean.
   */
  quiesce: boolean;
}

// `CapturedDisk` is re-exported from `@cloudable/schema` at the top of this file rather
// than declared here. It used to be declared in both places, structurally identical and
// free to drift; the column is the thing that has to be right, so the column's package
// owns the shape. `externalId` is load-bearing, not decoration: without it nothing can
// read, restore from, or delete this copy when retention expires.

export interface SnapshotResult {
  disks: ReadonlyArray<CapturedDisk>;
  /** Real total across `disks`, read back from the provider. Never a placeholder. */
  sizeBytes: number;
}

export interface SnapshotReadGrant {
  /** Supports HTTP `Range` requests over the raw disk image, byte 0 = disk byte 0. */
  readUrl: string;
  /** When the provider stops honouring `readUrl`, regardless of session state. A session
   * outliving its grant re-grants rather than reading through a dead URL. */
  expiresAt: Date;
}

export interface ProvisioningService {
  create(desc: MachineDescriptor): Effect.Effect<MachineStatus, ProvisioningError>;
  /**
   * Copy the machine's disks and report what was copied.
   *
   * Added because `createSnapshot` wrote a database row and nothing else: it never
   * called this port — `domain/archive/snapshot.ts` did not even import it — and
   * stamped every row with the same hardcoded 32 GiB. Six "restorable" snapshots
   * existed in production against two real Azure objects.
   *
   * Returning the ids is the whole point. A snapshot the control plane cannot name at
   * the provider can never be restored from and can never be deleted when its
   * retention expires.
   */
  snapshot(desc: SnapshotDescriptor): Effect.Effect<SnapshotResult, ProvisioningError>;
  /**
   * Open a time-limited, READ-ONLY window onto one captured disk, for inspecting a
   * snapshot's filesystem without restoring it (`domain/archive/inspect.ts`).
   *
   * Returns a URL supporting HTTP range requests over the raw disk image. That is the
   * whole contract: the caller reads bytes at offsets and parses the filesystem itself,
   * so nothing provider-specific leaks past this boundary.
   *
   * The URL is a CREDENTIAL. It is never persisted — invariant 1 — and callers hold it
   * in memory for the life of one inspection session, then call `revokeSnapshotRead`.
   * Pair every grant with a revoke; an un-revoked grant stays usable at the provider
   * until its own duration elapses, whatever the control plane believes.
   */
  grantSnapshotRead(input: {
    provider: Provider;
    diskExternalId: string;
    durationSeconds: number;
  }): Effect.Effect<SnapshotReadGrant, ProvisioningError>;
  /** Ends the access `grantSnapshotRead` opened. Idempotent: revoking a disk with no live
   * grant is a no-op at the provider, not an error, so a double-close never fails. */
  revokeSnapshotRead(input: {
    provider: Provider;
    diskExternalId: string;
  }): Effect.Effect<void, ProvisioningError>;
  /**
   * Whether a disk this snapshot recorded still exists at the provider.
   *
   * A `snapshots` row names its copies by `CapturedDisk.externalId` and nothing
   * re-checks that the named object is still there. Production has rows pointing at
   * objects since replaced or cleaned up, and those rows still read "restorable" with a
   * live Restore button — so the one thing the product promises about a snapshot is
   * unverified. This is the check that makes it verifiable.
   *
   * A plain read, not a grant: on Azure it is `snapshots/read`, which the role already
   * has, so detecting this needs no new permission. Absence is reported as `false`
   * rather than as an error — a missing object is the ANSWER here, not a failure.
   */
  snapshotDiskExists(input: {
    provider: Provider;
    diskExternalId: string;
  }): Effect.Effect<boolean, ProvisioningError>;
  /**
   * Destroy one captured disk at the provider, permanently.
   *
   * This is what makes retention expiry real. The sweep in
   * `domain/archive/snapshot.ts` used to set `expiredAt` and stop there: the console
   * said the volume data was hard-deleted, compliance check #5 read
   * `snapshot.expired` as proof that it had been, and the managed-disk snapshots sat
   * in the subscription indefinitely. A check that goes green over a deletion that
   * never happened is worse than one that fails.
   *
   * Idempotent, like `revokeSnapshotRead`: a disk already gone is the state the caller
   * wanted, so it succeeds rather than erroring. That matters because the sweep retries
   * — a pass that deleted two of three disks and failed must be able to run again
   * without the two successes turning into errors the second time.
   *
   * Deletes the COPY, never the live disk it was copied from. The ids in
   * `snapshots.capturedDisks` only ever name snapshot objects, and the caller passes
   * nothing else.
   */
  deleteSnapshotDisk(input: {
    provider: Provider;
    diskExternalId: string;
  }): Effect.Effect<void, ProvisioningError>;
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
  /**
   * Put a snapshot's data disk back onto an existing machine. See
   * `RestoreDataDiskDescriptor`.
   *
   * Named `restoreDataDisk`, not `restore`: only the data disk is restored. `config` and
   * `full` restore modes have nothing behind them (no config is captured; secret bindings
   * are unimplemented) and are refused in `domain/archive/restore.ts` long before they
   * could reach this port.
   *
   * Not `archive` + `create` and not `reimage`: the first restarts the retention clock and
   * carries archive-lifecycle meaning, and the second deliberately PRESERVES the data disk
   * this operation exists to replace.
   */
  restoreDataDisk(desc: RestoreDataDiskDescriptor): Effect.Effect<MachineStatus, ProvisioningError>;
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
