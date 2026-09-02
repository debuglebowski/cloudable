/**
 * Wire types for `/api/v1/elevations` (feature unit 17 — elevation /
 * break-glass). Kept as plain TS types — framework-agnostic, for
 * any client (console, CLI) — mirroring `common.ts`'s convention. The
 * `@effect/platform` `Schema.Struct` runtime schemas that actually validate
 * these on the wire live alongside the route definitions in
 * `apps/control-plane/src/http/routes/elevations.ts`, and are kept
 * structurally in sync with these types by hand.
 */

/** Lower risk (file recovery) vs. higher risk (interactive shell, can read live injected secrets). */
export type ElevationLevel = "file_recovery" | "shell";

/**
 * `requested` — created, and (for the `with_approval` org policy) waiting on
 * an approval decision. `granted` — time-boxed access is live. `expired` —
 * a granted elevation whose `expiresAt` has passed. `denied` — the org
 * policy is `never`, or the approval was rejected/expired before a decision.
 */
export type ElevationStatus = "requested" | "granted" | "expired" | "denied";

/** Org policy for an admin connecting to a machine they do not own. */
export type AdminAccessPolicy = "never" | "always" | "with_approval";

export interface ElevationDto {
  id: string;
  orgId: string;
  personId: string;
  machineId: string;
  level: ElevationLevel;
  reason: string;
  approvalId: string | null;
  /** ISO 8601, null until granted. */
  grantedAt: string | null;
  /** ISO 8601, null until granted. */
  expiresAt: string | null;
  status: ElevationStatus;
}

// `personId` is gone from the wire — the server derives the requesting
// person from the caller's session (`CurrentUserTag`), not the body.
export interface RequestElevationBody {
  machineId: string;
  level: ElevationLevel;
  /** Required free text — never optional. */
  reason: string;
}
