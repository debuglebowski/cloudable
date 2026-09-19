export type ApprovalMode = "none" | "single" | "dual";
export type RestoreMode = "data" | "config" | "full";

/**
 * Escalating approval-bar rule for snapshot restores ("Restore modes").
 *
 * `ApprovalService.request()` (see `services/ApprovalService.ts`) resolves ONE approval
 * mode per `actionType` from the org's own policy (the `approval_mode:snapshot_restore`
 * setting), and every restore — data, config, or full — shares the single actionType
 * `"snapshot_restore"`. The generic service therefore cannot by itself tell a
 * data-only restore from a full restore of secret bindings; this function is
 * Cloudable's own escalation layer sitting in front of that generic gate, expressed as
 * a MINIMUM required mode per restore mode:
 *
 *   - `"data"`   — `"none"`: no minimum. The org's own configured policy applies
 *                  unmodified, and per spec can legitimately resolve to `"none"`.
 *   - `"config"` — `"single"`: always at least one approver, even if the org has
 *                  configured `"none"` for `approval_mode:snapshot_restore`.
 *   - `"full"`   — `"dual"`, always. This is deliberate and hardcoded rather than
 *                  merely floored: reattaching secret bindings is meant to be the
 *                  hardest restore to reach, independent of whatever an org has
 *                  configured for `approval_mode:snapshot_restore`.
 *
 * `restore.ts` passes the resolved floor as `ApprovalRequest.requiredModeFloor`, which
 * `ApprovalService.request()` now enforces structurally — it clamps the org's configured
 * mode UP to this floor, never down, so a weaker org configuration (e.g. `"none"`) can
 * never satisfy less than what's required here. Same FLOOR concept as
 * `domain/elevation/policy.ts`'s `requiredApprovalModeFloor` for `admin_access` — but a
 * different enforcement mechanism: that unit's floor is a pre-check that hard-refuses
 * the request outright unless the org's own configured mode already satisfies it,
 * whereas this one is clamped up automatically, so the request always proceeds at (at
 * least) the required floor rather than being rejected. `"full"` is additionally,
 * independently gated by requiring an explicit `confirmSecretBindings` acknowledgement
 * before an approval is even requested.
 */
/**
 * What the restore is aimed at. A second axis on top of `mode`, because the mode says what
 * is written back and this says what it lands on — and overwriting a machine that is
 * running is destructive in a way neither of the other two are.
 *
 *   - `"new_machine"`      — nothing existing is touched.
 *   - `"archived_machine"` — its disks are already gone (`archive()` deleted them), so
 *                            there is nothing left to destroy.
 *   - `"live_machine"`     — its current data disk is destroyed and replaced.
 */
export type RestoreTargetKind = "new_machine" | "archived_machine" | "live_machine";

const RANK: Record<ApprovalMode, number> = { none: 0, single: 1, dual: 2 };

/** The stronger of two floors. Floors only ever clamp UP. */
const strongest = (a: ApprovalMode, b: ApprovalMode): ApprovalMode => (RANK[a] >= RANK[b] ? a : b);

// `target` is required, deliberately un-defaulted: a default would have to pick either the
// safest or the most destructive kind, and both are wrong to assume on a caller's behalf.
export function resolveRestoreApprovalFloor(
  mode: RestoreMode,
  target: RestoreTargetKind,
): ApprovalMode {
  const byMode: ApprovalMode = mode === "full" ? "dual" : mode === "config" ? "single" : "none";
  // Destroying a running machine's data is at least as serious as a config restore, and
  // the org cannot configure its way below that. An archived target destroys nothing and
  // a new machine touches nothing existing, so both keep the mode's own floor.
  const byTarget: ApprovalMode = target === "live_machine" ? "dual" : "none";
  return strongest(byMode, byTarget);
}
