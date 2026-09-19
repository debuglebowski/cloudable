import { Effect, Layer, Ref } from "effect";
import {
  type CapturedDisk,
  type MachineDescriptor,
  type MachineStatus,
  ProvisioningError,
  type ProvisioningService,
  ProvisioningServiceTag,
  type ReimageDescriptor,
  type SnapshotReadGrant,
  type SnapshotResult,
} from "./ProvisioningService";

interface FakeMachineEntry {
  status: MachineStatus;
  /** Declared at `create()` time — see `MachineDescriptor.packages`. */
  declaredPackages: ReadonlyArray<string>;
  /** The snapshot disk this machine was last restored from, if ever. Exposed so a test can
   * assert the restore used the snapshot it was asked for, not merely that one happened. */
  restoredFromDiskId?: string;
}

export interface FakeProvisioningOptions {
  /**
   * Extra "installed" software to report on every subsequent `reconcile()`
   * call for a given machine id, standing in for what a real control agent
   * would observe running on the box (see `docs/agents.md`). This is how
   * tests and demos give the reconciliation loop (and, later, compliance
   * checks) real drift to detect — the fake never installs anything itself
   * (invariants #4, #5); it only ever reports what reconcile() would find.
   */
  simulatedExtraPackages?: ReadonlyMap<string, ReadonlyArray<string>>;
  /**
   * Absolute paths to real disk images, keyed by `CapturedDisk.externalId`, returned by
   * `grantSnapshotRead` as `file://` URLs.
   *
   * This is what lets snapshot inspection be tested end to end — HTTP route, access gate,
   * session lifecycle, ext4 reader — against a genuine filesystem image with no cloud
   * account. A fake that returned invented directory listings would test the plumbing
   * against itself and prove nothing about whether the reader can read a real ext4.
   */
  snapshotImages?: ReadonlyMap<string, string>;
  /**
   * Served for ANY disk id, when no per-id entry matches. `config.fakeSnapshotImagePath`
   * sets it for local development, where there is otherwise no readable snapshot to look
   * at — the docker provider captures no disks.
   */
  fallbackSnapshotImage?: string | null;
}

/**
 * Dev/test-only sentinel `targetImage`: reimaging to this value (via unit
 * 18's `upgradeMachine`) lands the fake machine in `"error"` state instead
 * of `"running"`, so the subsequent `reconcile()` call — the "verify
 * declared state" step — reports a mismatch. This is how the transactional
 * upgrade rollback path is exercised end-to-end (unit tests and manual
 * `curl` verification) without a real Azure account. It is not a real image
 * name and `ProvisioningService.azure.ts` has no matching behavior.
 */
export const FAKE_VERIFICATION_FAILURE_IMAGE = "cloudable/dev-force-verification-failure";

/**
 * Dev/test-only sentinel `image`: creating a fake machine with this value
 * makes `create()` fail with a `ProvisioningError` instead of settling on
 * "running", so `MachineService.create`'s error path (persisting
 * `machines.lastError` and emitting `machine.provisioning_failed`) can be
 * exercised end-to-end without a real Azure account. Not a real image name
 * and `ProvisioningService.azure.ts` has no matching behavior.
 */
export const FAKE_CREATE_FAILURE_IMAGE = "cloudable/dev-force-create-failure";

/**
 * In-memory `ProvisioningService` for dev/test — no real Azure account
 * exists in this build (see `ProvisioningService.azure.ts`). `create` moves
 * a machine through "provisioning" then "running" synchronously; `archive`
 * flips it to "archived"; `reconcile` only ever reports the machine's
 * current status plus its currently-observed packages (invariants #4, #5 —
 * never installs, never auto-corrects; see `src/reconcile/reconcile-machine.ts`
 * for the code that decides what counts as drift); `reimage` (unit 18) moves
 * it through "provisioning" then back to "running" — unless `targetImage` is
 * `FAKE_VERIFICATION_FAILURE_IMAGE`, in which case it settles on "error" to
 * simulate a machine that came up broken/drifted post-reimage.
 */
export const makeFakeProvisioningServiceLive = (
  options: FakeProvisioningOptions = {},
): Layer.Layer<ProvisioningServiceTag> =>
  Layer.effect(
    ProvisioningServiceTag,
    Effect.gen(function* () {
      const state = yield* Ref.make(new Map<string, FakeMachineEntry>());
      // Disk ids destroyed by `deleteSnapshotDisk`. Tracked rather than ignored so a
      // test can assert that expiry actually deleted something: the bug this whole path
      // exists to close was a sweep that reported deletion and performed none, which a
      // no-op fake would reproduce exactly.
      const deletedDisks = yield* Ref.make(new Set<string>());

      const require = (machineId: string): Effect.Effect<FakeMachineEntry, ProvisioningError> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const existing = current.get(machineId);
          if (!existing) {
            return yield* Effect.fail(
              new ProvisioningError({
                reason: "not_found",
                cause: `unknown machineId: ${machineId}`,
              }),
            );
          }
          return existing;
        });

      const reportedPackagesFor = (machineId: string, declaredPackages: ReadonlyArray<string>) => [
        ...declaredPackages,
        ...(options.simulatedExtraPackages?.get(machineId) ?? []),
      ];

      const create: ProvisioningService["create"] = (desc: MachineDescriptor) =>
        Effect.gen(function* () {
          if (desc.image === FAKE_CREATE_FAILURE_IMAGE) {
            return yield* Effect.fail(
              new ProvisioningError({
                reason: "provider_error",
                cause: "simulated create failure (dev sentinel image)",
              }),
            );
          }

          const declaredPackages = desc.packages ?? [];

          const provisioning: FakeMachineEntry = {
            status: { machineId: desc.machineId, state: "provisioning", externalId: null },
            declaredPackages,
          };
          yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, provisioning));

          const running: FakeMachineEntry = {
            status: {
              machineId: desc.machineId,
              state: "running",
              externalId: `fake-${desc.machineId}`,
              reportedPackages: reportedPackagesFor(desc.machineId, declaredPackages),
            },
            declaredPackages,
          };
          yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, running));

          return running.status;
        });

      // Reports a plausible capture rather than an empty one, so a test can tell the
      // difference between "the snapshot port was called" and "nothing happened". The
      // sizes are arbitrary but DIFFER per disk and per machine, deliberately: the bug
      // this port exists to fix was every snapshot in the system reporting one hardcoded
      // size, and a fake returning a constant would reproduce it in every test.
      const snapshot: ProvisioningService["snapshot"] = (desc) =>
        Effect.gen(function* () {
          const existing = yield* require(desc.machineId);
          const seed = desc.machineId.length * 1_000_000;
          const disks: CapturedDisk[] = [];
          // "shallow" omits the OS disk, the same way the azure adapter does.
          if (desc.scope === "full") {
            disks.push({
              kind: "os",
              externalId: `fake-snap-os-${existing.status.machineId}-${desc.snapshotId}`,
              sizeBytes: 30 * 1024 * 1024 * 1024 + seed,
            });
          }
          disks.push({
            kind: "data",
            externalId: `fake-snap-data-${existing.status.machineId}-${desc.snapshotId}`,
            sizeBytes: 64 * 1024 * 1024 * 1024 + seed,
          });
          return {
            disks,
            sizeBytes: disks.reduce((total, disk) => total + disk.sizeBytes, 0),
          } satisfies SnapshotResult;
        });

      const grantSnapshotRead: ProvisioningService["grantSnapshotRead"] = ({
        diskExternalId,
        durationSeconds,
      }) =>
        Effect.gen(function* () {
          const path =
            options.snapshotImages?.get(diskExternalId) ?? options.fallbackSnapshotImage ?? null;
          if (!path) {
            // Deliberately `not_found` rather than a stub URL: a test that forgot to
            // register an image should fail where the image is missing, not later with an
            // unreadable superblock.
            return yield* Effect.fail(
              new ProvisioningError({
                reason: "not_found",
                cause: `no fake snapshot image registered for ${diskExternalId}`,
              }),
            );
          }
          return {
            readUrl: `file://${path}`,
            expiresAt: new Date(Date.now() + durationSeconds * 1000),
          } satisfies SnapshotReadGrant;
        });

      // Nothing to release for a local file. Still a real no-op rather than a failure:
      // every close path calls this, including for disks that were never granted.
      const revokeSnapshotRead: ProvisioningService["revokeSnapshotRead"] = () => Effect.void;

      const snapshotDiskExists: ProvisioningService["snapshotDiskExists"] = ({ diskExternalId }) =>
        Effect.gen(function* () {
          // A deleted disk is gone, whatever image the options still map it to — expiry
          // and the integrity sweep read the same provider, so they have to agree.
          if ((yield* Ref.get(deletedDisks)).has(diskExternalId)) return false;
          return (
            options.snapshotImages?.has(diskExternalId) === true ||
            options.fallbackSnapshotImage != null
          );
        });

      const deleteSnapshotDisk: ProvisioningService["deleteSnapshotDisk"] = ({ diskExternalId }) =>
        Ref.update(deletedDisks, (ids) => new Set(ids).add(diskExternalId));

      const archive: ProvisioningService["archive"] = (machineId: string, _provider) =>
        Effect.gen(function* () {
          const existing = yield* require(machineId);
          const archived: FakeMachineEntry = {
            ...existing,
            status: { ...existing.status, state: "archived" },
          };
          yield* Ref.update(state, (map) => new Map(map).set(machineId, archived));
          return archived.status;
        });

      const reconcile: ProvisioningService["reconcile"] = (machineId: string, _provider) =>
        Effect.gen(function* () {
          const existing = yield* require(machineId);
          if (existing.status.state === "archived") {
            // Nothing to observe on an archived machine — report as-is.
            return existing.status;
          }
          return {
            ...existing.status,
            reportedPackages: reportedPackagesFor(machineId, existing.declaredPackages),
          } satisfies MachineStatus;
        });

      const reimage: ProvisioningService["reimage"] = (desc: ReimageDescriptor) =>
        Effect.gen(function* () {
          const existing = yield* require(desc.machineId);

          const provisioning: FakeMachineEntry = {
            ...existing,
            status: { ...existing.status, state: "provisioning" },
          };
          yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, provisioning));

          const finalState: MachineStatus["state"] =
            desc.targetImage === FAKE_VERIFICATION_FAILURE_IMAGE ? "error" : "running";
          const settled: FakeMachineEntry = {
            ...existing,
            status: {
              ...existing.status,
              state: finalState,
              reportedPackages: reportedPackagesFor(desc.machineId, existing.declaredPackages),
            },
          };
          yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, settled));

          return settled.status;
        });

      const restoreDataDisk: ProvisioningService["restoreDataDisk"] = (desc) =>
        Effect.gen(function* () {
          const existing = yield* require(desc.machineId);
          // Records WHICH snapshot disk it was asked for. A fake that ignored it would
          // pass a test that restored entirely the wrong snapshot — the same reason
          // `snapshot` above returns sizes that differ per disk instead of a constant.
          const restored: FakeMachineEntry = {
            ...existing,
            status: { ...existing.status, state: "provisioning" },
            restoredFromDiskId: desc.dataDiskSnapshotId,
          };
          yield* Ref.update(state, (map) => new Map(map).set(desc.machineId, restored));
          return restored.status;
        });

      const restart: ProvisioningService["restart"] = (machineId: string, _provider) =>
        Effect.gen(function* () {
          const existing = yield* require(machineId);
          const restarted: FakeMachineEntry = {
            ...existing,
            status: { ...existing.status, state: "running" },
          };
          yield* Ref.update(state, (map) => new Map(map).set(machineId, restarted));
          return restarted.status;
        });

      return {
        create,
        snapshot,
        grantSnapshotRead,
        revokeSnapshotRead,
        snapshotDiskExists,
        deleteSnapshotDisk,
        restoreDataDisk,
        archive,
        reconcile,
        reimage,
        restart,
      } satisfies ProvisioningService;
    }),
  );

export const FakeProvisioningServiceLive = makeFakeProvisioningServiceLive();
