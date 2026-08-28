export type SnapshotSubState = "restorable" | "expired";

/** Computed sub-state (spec §14 "Archived sub-states") — never stored as its own
 * column, always derived from whether `expiredAt` has been set. */
export function getSnapshotSubState(snapshot: { expiredAt: Date | null }): SnapshotSubState {
  return snapshot.expiredAt ? "expired" : "restorable";
}

/** Human-readable reason restore is unavailable, or `null` when it's available.
 * Callers must grey out restore WITH this reason shown — never just hide it. */
export function restoreUnavailableReason(snapshot: { expiredAt: Date | null }): string | null {
  if (!snapshot.expiredAt) return null;
  return `This snapshot expired on ${snapshot.expiredAt.toISOString()}: its retention window elapsed and the underlying volume data was hard-deleted. The record and its full audit history remain permanent, but restore is unavailable.`;
}
