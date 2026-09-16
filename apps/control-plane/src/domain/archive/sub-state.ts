/**
 * True when the provider copied no disks for this snapshot, so it names nothing and
 * there is nothing to restore from. Every row written before `createSnapshot` called a
 * provider is in this state — six of them are in production.
 *
 * Present AND empty. An ABSENT field means the caller did not tell us, which is not the
 * same claim as "the provider copied nothing" — reading it that way would make every
 * snapshot look empty to any caller that omits the field, which is the same
 * over-claiming in the other direction. The column is notNull with a '[]' default, so a
 * real row always carries it.
 */
export function capturedNothing(snapshot: { capturedDisks?: unknown }): boolean {
  return Array.isArray(snapshot.capturedDisks) && snapshot.capturedDisks.length === 0;
}

export type SnapshotSubState = "restorable" | "expired" | "empty" | "data_missing";

/**
 * Computed sub-state — never stored as its own column.
 *
 * `empty` is checked first, for the same reason `restoreUnavailableReason` checks it
 * first: a snapshot that captured nothing and then passed its retention window is not
 * "expired". Expiry means the data existed and was deleted on schedule, and saying that
 * about data which never existed is a claim about a deletion that never happened.
 *
 * Before `empty` existed this was derived from `expiredAt` alone, so a snapshot holding
 * nothing displayed as "restorable" with a working Restore button.
 */
export function getSnapshotSubState(snapshot: {
  expiredAt: Date | null;
  dataMissingAt?: Date | null;
  capturedDisks?: unknown;
}): SnapshotSubState {
  if (capturedNothing(snapshot)) return "empty";
  // Expiry wins over data_missing: once the retention window has elapsed the data being
  // gone is the expected outcome, not an anomaly. `data_missing` is specifically "gone
  // while it should still have been here".
  if (snapshot.expiredAt) return "expired";
  if (snapshot.dataMissingAt) return "data_missing";
  return "restorable";
}

/** Human-readable reason restore is unavailable, or `null` when it's available.
 * Callers must grey out restore WITH this reason shown — never just hide it.
 *
 * Ordered the same way `getSnapshotSubState` is, and for the same reason: a row can be
 * several of these at once, and the one a person needs told is the most specific true
 * one. */
export function restoreUnavailableReason(snapshot: {
  expiredAt: Date | null;
  dataMissingAt?: Date | null;
  capturedDisks?: unknown;
}): string | null {
  // Checked before expiry, same ordering and same reason as `getSnapshotSubState`.
  if (capturedNothing(snapshot)) {
    return "This snapshot records no disks at the provider, so there is nothing to restore from. It was created before snapshots captured anything — the record and its audit history are permanent, but no data was ever stored.";
  }
  if (snapshot.expiredAt) {
    return `This snapshot expired on ${snapshot.expiredAt.toISOString()}: its retention window elapsed and the underlying volume data was hard-deleted. The record and its full audit history remain permanent, but restore is unavailable.`;
  }
  if (snapshot.dataMissingAt) {
    return `On ${snapshot.dataMissingAt.toISOString()} the disks this snapshot records were found to no longer exist at the provider, while its retention window was still open. Nothing here can be restored or read. The record and its audit history are permanent; the data is not. This is a retention failure, not an expiry — the data went away early and nothing recorded why.`;
  }
  return null;
}
