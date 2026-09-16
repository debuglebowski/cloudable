export type SnapshotSubState = "restorable" | "expired";

/** Computed sub-state — never stored as its own
 * column, always derived from whether `expiredAt` has been set. */
export function getSnapshotSubState(snapshot: { expiredAt: Date | null }): SnapshotSubState {
  return snapshot.expiredAt ? "expired" : "restorable";
}

/** True when the provider copied no disks for this snapshot, so it names nothing and
 * there is nothing to restore from. Every row written before `createSnapshot` called a
 * provider is in this state. */
export function capturedNothing(snapshot: { capturedDisks?: unknown }): boolean {
  // Present AND empty. An ABSENT field means the caller did not tell us, which is not
  // the same claim as "the provider copied nothing" — reading it that way would make
  // every snapshot look empty to any caller that omits the field, which is exactly the
  // over-claiming this function exists to stop. The column is notNull with a '[]'
  // default, so a real row always carries it.
  return Array.isArray(snapshot.capturedDisks) && snapshot.capturedDisks.length === 0;
}

/** Human-readable reason restore is unavailable, or `null` when it's available.
 * Callers must grey out restore WITH this reason shown — never just hide it. */
export function restoreUnavailableReason(snapshot: {
  expiredAt: Date | null;
  capturedDisks?: unknown;
}): string | null {
  // Checked before expiry: a snapshot that captured nothing and then passed its
  // retention window would otherwise be explained as "the data was hard-deleted",
  // which claims data existed. It never did.
  if (capturedNothing(snapshot)) {
    return "This snapshot records no disks at the provider, so there is nothing to restore from. It was created before snapshots captured anything — the record and its audit history are permanent, but no data was ever stored.";
  }
  if (!snapshot.expiredAt) return null;
  return `This snapshot expired on ${snapshot.expiredAt.toISOString()}: its retention window elapsed and the underlying volume data was hard-deleted. The record and its full audit history remain permanent, but restore is unavailable.`;
}
