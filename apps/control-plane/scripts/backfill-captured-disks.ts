#!/usr/bin/env bun
/**
 * One-off repair for `snapshots` rows that say they captured nothing while their copies
 * sit in Azure.
 *
 * `capturedDisks` only started being written on 2026-09-16 (`19b14ad`). Before it, the
 * archive path made the managed-disk copy and discarded the result, so the row recorded
 * that a snapshot existed but never where. `getSnapshotSubState` reads an empty
 * `capturedDisks` as "empty", so the console tells the machine's owner their archive holds
 * no data — while 154 GiB of it sits unattached in `rg-cloudable-managed`.
 *
 * That is the inverse of the expiry bug fixed in `de4c821`. There, the record claimed a
 * deletion that never happened. Here, it denies data that is really there. Both are the
 * record disagreeing with the provider, and in both the provider is right.
 *
 * WHY BACKFILL RATHER THAN DELETE
 *
 * Every row below is still INSIDE its retention window (they expire 2026-10-09 and
 * 2026-10-12). Deleting the copies by hand today would destroy data the product's own
 * policy says to keep, three weeks early — the same class of failure `snapshot.data_missing`
 * exists to flag, committed deliberately. Naming the copies instead makes the row true,
 * gives the data a real expiry date, and lets `expireOverdueSnapshots` destroy it on
 * schedule with an audit record naming every id. Same end state, three weeks later, with
 * evidence.
 *
 * WHY containsData IS WITHDRAWN ON TWO OF THEM
 *
 * `bold-beacon` and `quick-comet` have only an OS snapshot. Their data disks were deleted
 * outright by the archive path as it was before `75415af` — the one whose own comment
 * records that "its data can still be restored from Archive" was false when it said it.
 * Writing just the surviving OS id would flip those rows from "empty" to "restorable",
 * which swaps one wrong answer for another: the row's `scope: "full"` promises a data disk
 * that no longer exists. So the correction also sets `containsData: false`. The row then
 * says the true thing available — the OS disk survived, the data did not.
 *
 * `happy-maple` keeps `containsData: true`. Both its disks are there.
 *
 * SAFETY
 *
 * Dry run unless `--apply` is passed.
 *
 *   - Targets three row ids EXPLICITLY. No pattern matching, no discovery: this repairs
 *     known rows whose provider objects were checked by hand, and a query that found its
 *     own targets could pick up a row this reasoning was never applied to.
 *   - Re-reads every disk from Azure first and refuses to write an id the provider does
 *     not currently return. The ids below were verified on 2026-09-19; an object deleted
 *     since must not be written into a row as if it were still there.
 *   - Skips any row whose `capturedDisks` is already non-empty — something else fixed it,
 *     and that fix is the one to keep.
 *   - Skips any row already expired. Past retention is a different situation than this
 *     script reasons about, and it is not the one to make restorable again.
 *   - Writes `snapshot.record_corrected` for every row it touches. A row flipping from
 *     "empty" to "restorable" with nothing explaining why is exactly the unexplained state
 *     change this product exists to not have.
 *
 * Usage, from the repo root:
 *   bun run --cwd apps/control-plane scripts/backfill-captured-disks.ts
 *   bun run --cwd apps/control-plane scripts/backfill-captured-disks.ts --apply
 *
 * Needs DATABASE_URL reachable — the production Postgres has public access disabled, so
 * this runs from inside the VNet (a one-off job in the container app environment), not
 * from a laptop.
 */
import { ComputeManagementClient } from "@azure/arm-compute";
import { DefaultAzureCredential } from "@azure/identity";
import { type CapturedDisk, snapshots } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ulid } from "ulid";
import { config } from "../src/config";
import { Db, DbLive } from "../src/db/layer";
import { EventBus } from "../src/services/EventBus";

const APPLY = process.argv.includes("--apply");
const ACTOR_ID = "captured-disks-backfill";

interface Target {
  snapshotId: string;
  /** Only for the log — the row carries its own machine id, which is what gets used. */
  label: string;
  /** Azure snapshot RESOURCE NAMES, not ids: the id is rebuilt from what ARM returns, so
   * a name that no longer resolves simply yields nothing to write. */
  diskNames: ReadonlyArray<{ kind: CapturedDisk["kind"]; name: string }>;
  /** Set false where the data disk is gone and the row must stop claiming to hold data. */
  containsData: boolean;
  reason: string;
}

/**
 * Verified by hand against `rg-cloudable-managed` on 2026-09-19, and cross-checked against
 * `cloudable snapshots list`: each of these rows reported "empty / not recorded" while the
 * named objects existed, unattached and healthy.
 *
 * The other three "empty" rows in production (41a740e7, 660dde3b, cf4b097e) are NOT here:
 * they have no surviving object at all. There is nothing to name, and inventing an id for
 * them would be the exact failure this repairs.
 */
const TARGETS: ReadonlyArray<Target> = [
  {
    snapshotId: "6942d627-41b6-44cf-9c87-161953f50709",
    label: "happy-maple (df08e7d3)",
    diskNames: [
      { kind: "os", name: "cldm-happy-maple-dd43-df08e7d33cd4-os-snap" },
      { kind: "data", name: "cldm-happy-maple-dd43-df08e7d33cd4-data-snap" },
    ],
    containsData: true,
    reason:
      "Archived 2026-09-15, before capturedDisks was recorded. Both disks survive; the row is restorable and always was.",
  },
  {
    snapshotId: "9f987530-7ca2-40b4-b2fe-9c7434834749",
    label: "bold-beacon (8d4a53a8)",
    diskNames: [{ kind: "os", name: "cldm-bold-beacon-39f6-8d4a53a8d5dc-os-snap" }],
    containsData: false,
    reason:
      "Archived 2026-09-12, before capturedDisks was recorded and before archive snapshotted the data disk. The OS disk survives; the data disk was deleted at archive time and cannot be recovered.",
  },
  {
    snapshotId: "93375e8d-d820-4601-9302-b4f5395fb4ae",
    label: "quick-comet (0d547538)",
    diskNames: [{ kind: "os", name: "cldm-quick-comet-c2eb-0d547538a89d-os-snap" }],
    containsData: false,
    reason:
      "Archived 2026-09-12, before capturedDisks was recorded and before archive snapshotted the data disk. The OS disk survives; the data disk was deleted at archive time and cannot be recovered.",
  },
];

const formatGib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

const program = Effect.gen(function* () {
  const subscriptionId = config.azureSubscriptionId;
  if (!subscriptionId) {
    yield* Effect.logError("AZURE_SUBSCRIPTION_ID is not set — cannot verify any disk exists");
    return 1;
  }
  const resourceGroup = config.azureMachinesResourceGroup;
  yield* Effect.logInfo(`subscription:   ${subscriptionId}`);
  yield* Effect.logInfo(`resource group: ${resourceGroup}`);
  if (!APPLY) yield* Effect.logInfo("DRY RUN — pass --apply to write");

  const db = yield* Db;
  const eventBus = yield* EventBus;
  const compute = new ComputeManagementClient(new DefaultAzureCredential(), subscriptionId);

  let corrected = 0;
  for (const target of TARGETS) {
    const rows = yield* Effect.promise(() =>
      db.select().from(snapshots).where(eq(snapshots.id, target.snapshotId)),
    );
    const row = rows[0];
    if (!row) {
      yield* Effect.logError(`  ${target.label}: row ${target.snapshotId} not found — skipped`);
      continue;
    }
    if (row.capturedDisks.length > 0) {
      yield* Effect.logInfo(
        `  ${target.label}: already names ${row.capturedDisks.length} disk(s) — left alone`,
      );
      continue;
    }
    if (row.expiredAt) {
      yield* Effect.logInfo(
        `  ${target.label}: already expired ${row.expiredAt.toISOString()} — left alone`,
      );
      continue;
    }

    // Re-read from the provider rather than trusting the ids recorded above. An object
    // deleted since they were verified must not be written into a row as if it were there,
    // which is the same mistake in a new direction.
    const disks: CapturedDisk[] = [];
    let missing = false;
    for (const disk of target.diskNames) {
      const found = yield* Effect.tryPromise({
        try: () => compute.snapshots.get(resourceGroup, disk.name),
        catch: (cause) => new Error(String(cause)),
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (!found?.id) {
        yield* Effect.logError(`  ${target.label}: ${disk.name} no longer exists at the provider`);
        missing = true;
        continue;
      }
      disks.push({
        kind: disk.kind,
        externalId: found.id,
        sizeBytes: found.diskSizeBytes ?? 0,
      });
    }

    // All or nothing per row. A row half-named is a new wrong answer, not a better one.
    if (missing || disks.length !== target.diskNames.length) {
      yield* Effect.logError(`  ${target.label}: not every disk resolved — row left untouched`);
      continue;
    }

    const sizeBytes = disks.reduce((total, disk) => total + disk.sizeBytes, 0);
    const withdrewClaim = target.containsData
      ? null
      : "containsData set false: the data disk was destroyed at archive time and only the OS disk survives";

    yield* Effect.logInfo(
      `  ${target.label}: ${disks.length} disk(s), ${formatGib(sizeBytes)}${withdrewClaim ? ", withdrawing containsData" : ""}`,
    );
    for (const disk of disks) {
      yield* Effect.logInfo(
        `      ${disk.kind}: ${disk.externalId} (${formatGib(disk.sizeBytes)})`,
      );
    }
    if (!APPLY) continue;

    // Guarded on `capturedDisks` still being empty: between the read above and this write,
    // a real snapshot path may have named them legitimately, and that naming is the true
    // one. A no-op update means exactly that happened.
    const updated = yield* Effect.promise(() =>
      db
        .update(snapshots)
        .set({
          capturedDisks: disks,
          sizeBytes,
          ...(target.containsData ? {} : { containsData: false }),
        })
        .where(eq(snapshots.id, target.snapshotId))
        .returning({ id: snapshots.id }),
    );
    if (updated.length === 0) {
      yield* Effect.logInfo(`  ${target.label}: changed underneath this run — left alone`);
      continue;
    }

    yield* eventBus
      .publish([
        {
          id: "",
          recordedAt: new Date(),
          type: "snapshot.record_corrected",
          occurredAt: new Date(),
          orgId: row.orgId,
          actorType: "system",
          actorId: ACTOR_ID,
          machineId: row.machineId,
          correlationId: ulid(),
          schemaVersion: 1,
          payload: {
            capturedDiskExternalIds: disks.map((disk) => disk.externalId),
            sizeBytes,
            withdrewClaim,
            reason: target.reason,
          },
        },
      ])
      .pipe(
        Effect.catchAll((error) =>
          // The row is already corrected. Losing the event is bad; reverting a row that now
          // tells the truth to get rid of it would be worse. Report loudly and carry on.
          Effect.logError(
            `  ${target.label}: corrected, but its event failed to publish: ${String(error)}`,
          ),
        ),
      );
    corrected++;
  }

  yield* Effect.logInfo(
    APPLY
      ? `corrected ${corrected} of ${TARGETS.length} row(s)`
      : `${TARGETS.length} row(s) inspected — nothing written`,
  );
  return 0;
});

const exitCode = await Effect.runPromise(
  program.pipe(
    Effect.provide(Layer.mergeAll(EventBus.Default.pipe(Layer.provide(DbLive)), DbLive)),
  ),
);
process.exit(exitCode);
