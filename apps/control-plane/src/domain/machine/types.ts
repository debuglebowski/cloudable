/**
 * Mirrors the `state` enum on the `machines` table in `packages/schema`.
 * Kept as its own literal union here (rather than imported from the schema
 * package) so this domain module — which is meant to be pure and
 * dependency-free per `deriveEvents`'s doc comment — doesn't need a
 * dependency on Drizzle's inferred column types.
 */
export type MachineState =
  | "provisioning"
  | "running"
  | "stopped"
  | "archived_restorable"
  | "archived_expired"
  | "error";

/**
 * The fields of machine state that `deriveEvents` (see `./events.ts`) diffs
 * report-over-report. Shared between what the control plane last persisted
 * (`MachineLastKnownState`) and what the agent has just reported
 * (`MachineReportedState`) — it's the same shape on both sides of the diff.
 */
interface MachineStateSnapshot {
  state: MachineState;
  /**
   * A digest of the installed-package list. The agent computes this by
   * hashing its own package inventory and reports the digest; this unit
   * never inspects packages itself, it only ever compares hashes for
   * equality (a change here means *some* package changed, without needing
   * to know which).
   */
  packagesHash: string;
  /**
   * Packages present on the machine but absent from its declared manifest.
   * Reconcile only ever surfaces these, never installs anything
   * (CLAUDE.md invariant #4), and drift is flagged, never auto-corrected
   * (invariant #5) — this list is the flag.
   */
  undeclaredPackages: string[];
  /** The cloud provider's resource id for the machine, once provisioned. Mirrors `machines.externalResourceId`. Null before provisioning completes. */
  externalResourceId: string | null;
}

/**
 * The control plane's persisted view of a machine's state as of its last
 * report. Passing `undefined` (not a value of this type) to `deriveEvents`
 * is how a caller says "this machine has never reported before".
 */
export type MachineLastKnownState = MachineStateSnapshot;

/**
 * What the agent has just reported.
 *
 * Carries `agentVersion` in addition to the fields shared with
 * `MachineLastKnownState` — needed for `machine.first_seen`'s payload
 * (`{ agentVersion: string }`, see `packages/events`). The agent already
 * reports its version as part of "installed packages and config state"
 * (spec §8.1), so it rides along on every report rather than requiring a
 * separate attest-time field.
 */
export interface MachineReportedState extends MachineStateSnapshot {
  agentVersion: string;
}
