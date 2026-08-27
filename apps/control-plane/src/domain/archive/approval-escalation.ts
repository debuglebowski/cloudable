export type ApprovalMode = "none" | "single" | "dual";
export type RestoreMode = "data" | "config" | "full";

const RANK: Record<ApprovalMode, number> = { none: 0, single: 1, dual: 2 };

/**
 * Escalating approval-bar rule for snapshot restores (spec §14 "Restore modes").
 *
 * `ApprovalService.request()` (see `services/ApprovalService.ts`) resolves ONE approval
 * mode per `actionType`, and every restore — data, config, or full — shares the single
 * actionType `"snapshot_restore"`. The generic service therefore cannot by itself tell
 * a data-only restore from a full restore of secret bindings; this function is
 * Cloudable's own escalation layer sitting in front of that generic gate:
 *
 *   - `"data"`   — the org's own restore-approval policy, unmodified. This is the
 *                  lowest bar, and per spec can legitimately be `"none"`.
 *   - `"config"` — the org's policy, floored at `"single"`: always at least one
 *                  approver, even if the org has configured `"none"` for data restores.
 *   - `"full"`   — always `"dual"`, regardless of org policy. This is deliberate and
 *                  hardcoded rather than merely floored: reattaching secret bindings is
 *                  meant to be the hardest restore to reach, independent of whatever an
 *                  org has configured for the other two modes.
 *
 * The resolved floor is not a value `ApprovalService` can currently consume directly
 * (its `request()` has no mode parameter — see the note in `restore.ts`); it is carried
 * across that interface boundary in the approval's `reason` text for reviewer/audit
 * visibility, and is independently enforced for `"full"` by requiring an explicit
 * `confirmSecretBindings` acknowledgement before an approval is even requested.
 */
export function resolveRestoreApprovalFloor(
  mode: RestoreMode,
  orgPolicy: ApprovalMode,
): ApprovalMode {
  if (mode === "full") return "dual";
  if (mode === "config") return RANK[orgPolicy] >= RANK.single ? orgPolicy : "single";
  return orgPolicy;
}
