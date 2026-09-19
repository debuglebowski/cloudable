#!/usr/bin/env bun
/**
 * One-off reconciliation: managed-disk snapshots in the machines resource group that no
 * `snapshots` row names.
 *
 * The expiry sweep now deletes every id in `snapshots.capturedDisks` before marking a row
 * expired, so from here on nothing leaks. This is about what leaked BEFORE that. Two
 * sources:
 *
 *   1. Rows written before snapshots captured real ids — `capturedDisks: []`. Six exist in
 *      production. The copy was made; nothing wrote down where. The row expires claiming
 *      no deletion (honestly), and whatever it points at is unreachable from the database.
 *   2. Snapshots taken by the old `archive` path, which created the copy inline and threw
 *      the result away entirely.
 *
 * Neither is visible from the control plane: it has no handle on the object. Only Azure
 * knows, which is why this reads the subscription rather than the database for the
 * left-hand side of the comparison.
 *
 * An orphan is an Azure snapshot whose resource id appears in NO row's `capturedDisks` —
 * across every row, expired or not, every org. Legal hold is irrelevant here: a held
 * snapshot's row still names its disks, so it is referenced and never an orphan.
 *
 * NO EVENTS ARE WRITTEN. An orphan has no row, so it has no org and no machine, and the
 * event envelope requires both — there is nothing to attach an audit record to, which is
 * the same fact that makes it an orphan. The script's own output IS the record: capture
 * it, because a deletion that leaves no trace anywhere is exactly the thing this codebase
 * otherwise refuses to do.
 *
 * SAFETY
 *
 * Dry run unless `--apply` is passed, and several rails on top of that, because the
 * failure mode here is deleting the only copy of someone's data:
 *
 *   - Refuses to apply when the database holds NO snapshot rows at all. That is far more
 *     likely to mean DATABASE_URL points somewhere empty or wrong than that every
 *     snapshot in the subscription is genuinely unreferenced, and in that state the
 *     comparison would classify all of them as orphans.
 *   - Skips anything created within `--newer-than` hours (default 24), so a snapshot
 *     taken while this runs — its row not yet written — is never a candidate.
 *   - Only considers names this system mints (`cldm…-snap`, with or without the row-id
 *     suffix added later). A snapshot someone made by hand in the same resource group is
 *     never touched, whatever its age.
 *   - Prints the database host and resource group before doing anything, so the operator
 *     can see what the two sides actually are.
 *
 * Usage, from the repo root:
 *   bun run --cwd apps/control-plane scripts/find-orphaned-snapshots.ts
 *   bun run --cwd apps/control-plane scripts/find-orphaned-snapshots.ts --apply | tee orphans.log
 *
 * DATABASE_URL must point at the control plane's database, and AZURE_SUBSCRIPTION_ID at
 * the subscription holding the machines. Azure credentials come from
 * `DefaultAzureCredential`, the same as the adapter.
 */
import { ComputeManagementClient } from "@azure/arm-compute";
import { DefaultAzureCredential } from "@azure/identity";
import { snapshots } from "@cloudable/schema";
import { Effect, Layer } from "effect";
import { config } from "../src/config";
import { Db, DbLive } from "../src/db/layer";

const APPLY = process.argv.includes("--apply");

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Hours. A snapshot younger than this may simply not have had its row written yet —
 * `createSnapshot` calls the provider and then inserts, so there is a real window. */
const newerThanHours = Number(flag("--newer-than") ?? "24");
const resourceGroup = flag("--resource-group") ?? config.azureMachinesResourceGroup;

/**
 * Names this system mints: `namesFor` produces a `cldm`-prefixed base, `snapshotOf`
 * appends `-snap` and (since snapshots became real) `-<8 hex of the row id>`. Both shapes
 * are matched because the older one is exactly what the leaked copies are named.
 *
 * Deliberately a prefix+suffix test rather than "everything in the resource group": the
 * resource group is not guaranteed to hold only our objects, and this script deletes.
 */
const OURS = /^cldm.*-snap(-[0-9a-f]{8})?$/i;

/** Hides the password when echoing back which database this is pointed at. */
function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

interface AzureSnapshot {
  id: string;
  name: string;
  timeCreated: Date | null;
  diskSizeBytes: number | null;
  sourceResourceId: string | null;
}

const formatGb = (bytes: number | null) =>
  bytes === null ? "unknown size" : `${(bytes / 1_000_000_000).toFixed(1)} GB`;

const program = Effect.gen(function* () {
  if (!Number.isFinite(newerThanHours) || newerThanHours < 0) {
    yield* Effect.logError("--newer-than must be a non-negative number of hours");
    return 1;
  }
  const subscriptionId = config.azureSubscriptionId;
  if (!subscriptionId) {
    yield* Effect.logError("AZURE_SUBSCRIPTION_ID is not set — nothing to reconcile against");
    return 1;
  }

  yield* Effect.logInfo(`database:       ${redactDatabaseUrl(config.databaseUrl)}`);
  yield* Effect.logInfo(`subscription:   ${subscriptionId}`);
  yield* Effect.logInfo(`resource group: ${resourceGroup}`);

  const db = yield* Db;
  const rows = yield* Effect.promise(() =>
    db.select({ id: snapshots.id, capturedDisks: snapshots.capturedDisks }).from(snapshots),
  );

  // Every id any row names, expired or not, across every org. Lowercased: ARM returns
  // resource ids with inconsistent casing on the resource-group segment, and a
  // case-sensitive miss here would read as "orphaned" for a snapshot that is referenced.
  const referenced = new Set<string>();
  for (const row of rows) {
    for (const disk of row.capturedDisks) referenced.add(disk.externalId.toLowerCase());
  }
  const rowsWithNoDisks = rows.filter((row) => row.capturedDisks.length === 0).length;

  yield* Effect.logInfo(
    `${rows.length} snapshot row(s) in the database, naming ${referenced.size} disk(s); ${rowsWithNoDisks} row(s) name nothing`,
  );

  const compute = new ComputeManagementClient(new DefaultAzureCredential(), subscriptionId);
  const listed = yield* Effect.tryPromise({
    try: async () => {
      const found: AzureSnapshot[] = [];
      for await (const snapshot of compute.snapshots.listByResourceGroup(resourceGroup)) {
        if (!snapshot.id || !snapshot.name) continue;
        found.push({
          id: snapshot.id,
          name: snapshot.name,
          timeCreated: snapshot.timeCreated ?? null,
          diskSizeBytes: snapshot.diskSizeBytes ?? null,
          sourceResourceId: snapshot.creationData?.sourceResourceId ?? null,
        });
      }
      return found;
    },
    catch: (cause) => new Error(`listing snapshots in ${resourceGroup} failed: ${String(cause)}`),
  }).pipe(
    // A listing that failed is NOT an empty resource group. Returning `null` rather than
    // `[]` keeps the two apart: the second would print "nothing to reconcile" and exit 0
    // over a subscription nobody managed to read.
    Effect.catchAll((error) => Effect.logError(error.message).pipe(Effect.as(null))),
  );
  if (listed === null) return 1;

  const found = listed;
  if (found.length === 0) {
    yield* Effect.logInfo(`no snapshots in ${resourceGroup} — nothing to reconcile`);
    return 0;
  }

  const now = Date.now();
  const cutoff = now - newerThanHours * 3_600_000;
  const skippedByName: string[] = [];
  const skippedAsRecent: string[] = [];
  const orphans: AzureSnapshot[] = [];

  for (const snapshot of found) {
    if (!OURS.test(snapshot.name)) {
      skippedByName.push(snapshot.name);
      continue;
    }
    if (referenced.has(snapshot.id.toLowerCase())) continue;
    // No creation time is treated as recent, not as old: unknown age must not be a reason
    // to delete something.
    if (snapshot.timeCreated === null || snapshot.timeCreated.getTime() > cutoff) {
      skippedAsRecent.push(snapshot.name);
      continue;
    }
    orphans.push(snapshot);
  }

  yield* Effect.logInfo(
    `${found.length} snapshot(s) in ${resourceGroup}: ${orphans.length} orphaned, ${skippedByName.length} not ours, ${skippedAsRecent.length} too recent to judge`,
  );
  for (const name of skippedByName) {
    yield* Effect.logInfo(`  not ours, untouched:  ${name}`);
  }
  for (const name of skippedAsRecent) {
    yield* Effect.logInfo(`  younger than ${newerThanHours}h:  ${name}`);
  }

  if (orphans.length === 0) {
    yield* Effect.logInfo("no orphans — every snapshot this system minted is named by a row");
    return 0;
  }

  yield* Effect.logInfo(
    APPLY ? "orphans, about to be DELETED:" : "orphans — DRY RUN, pass --apply to delete:",
  );
  for (const snapshot of orphans) {
    const age = snapshot.timeCreated
      ? `${Math.floor((now - snapshot.timeCreated.getTime()) / 86_400_000)}d old`
      : "age unknown";
    yield* Effect.logInfo(
      `  ${snapshot.name}  ${formatGb(snapshot.diskSizeBytes)}  ${age}  from ${snapshot.sourceResourceId ?? "unknown disk"}`,
    );
  }

  if (!APPLY) return 0;

  // The guard that matters most. An empty database makes every snapshot look unreferenced,
  // and the most likely cause of an empty database is being pointed at the wrong one.
  if (rows.length === 0) {
    yield* Effect.logError(
      "refusing to delete: the database holds no snapshot rows at all, so every snapshot " +
        "in the subscription looks orphaned. Check DATABASE_URL points at the control " +
        "plane's own database before running with --apply.",
    );
    return 1;
  }

  let deleted = 0;
  for (const snapshot of orphans) {
    const ok = yield* Effect.tryPromise({
      try: () => compute.snapshots.beginDeleteAndWait(resourceGroup, snapshot.name),
      catch: (cause) => new Error(String(cause)),
    }).pipe(
      Effect.as(true),
      Effect.catchAll((error) =>
        Effect.logError(`  ${snapshot.name} could not be deleted: ${error.message}`).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (ok) {
      yield* Effect.logInfo(`  deleted ${snapshot.name} (${formatGb(snapshot.diskSizeBytes)})`);
      deleted++;
    }
  }

  yield* Effect.logInfo(`deleted ${deleted} of ${orphans.length} orphaned snapshot(s)`);
  return deleted === orphans.length ? 0 : 1;
});

const exitCode = await Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(DbLive))));
process.exit(exitCode);
