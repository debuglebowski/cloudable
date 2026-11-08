/** Releases are supplied by the deployed control plane, never a public latest feed. */
export interface AgentRelease {
  readonly releaseId: string;
  readonly version: string;
  readonly artifacts: Readonly<
    Record<
      "linux-x64" | "linux-arm64",
      {
        readonly sha256: string;
        readonly downloadPath: string;
      }
    >
  >;
}
export interface AgentUpdateObservation {
  readonly id: string;
  readonly observedAt: string;
  readonly releaseId: string;
  readonly oldVersion: string;
  readonly newVersion: string;
  readonly status: "attempted" | "succeeded" | "failed" | "rolled_back";
  readonly detail?: string;
}
export interface AgentUpdateReport {
  readonly installedVersion: string;
  readonly desiredVersion: string | null;
  readonly releaseId: string | null;
  readonly status: string;
  readonly observations: readonly AgentUpdateObservation[];
}
