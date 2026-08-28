import type { MachineState } from "@/api/machines";
import type { BadgeProps } from "@/components/ui/badge";

/**
 * Spec §7 lists six machine states; the console's badge vocabulary only has three
 * semantic buckets (`ok` / `drift` / `stale`), so mapping six down to three is this
 * unit's call:
 *   running              -> ok         healthy, in service
 *   error                -> drift      needs attention — same visual weight as open drift
 *   provisioning         -> stale      not yet verified/settled
 *   archived_restorable  -> stale      inactive, still recoverable
 *   archived_expired     -> stale      inactive, retention window over
 *   stopped              -> secondary  deliberately idle, not a fault — neither "ok" nor
 *                                      "drift" nor "stale" in the compliance sense, so it
 *                                      gets a bare shadcn variant instead of one of those three
 */
export const MACHINE_STATE_BADGE_VARIANT: Record<MachineState, BadgeProps["variant"]> = {
  running: "ok",
  error: "drift",
  provisioning: "stale",
  archived_restorable: "stale",
  archived_expired: "stale",
  stopped: "secondary",
};

export const MACHINE_STATE_LABEL: Record<MachineState, string> = {
  running: "Running",
  error: "Error",
  provisioning: "Provisioning",
  archived_restorable: "Archived (restorable)",
  archived_expired: "Archived (expired)",
  stopped: "Stopped",
};

/**
 * Machines page shows archived rows behind a filter rather than hiding them entirely
 * (docs/frontend.md — Archive owns retention, but the row itself still lives here).
 */
export const ARCHIVED_MACHINE_STATES: ReadonlySet<MachineState> = new Set([
  "archived_restorable",
  "archived_expired",
]);
