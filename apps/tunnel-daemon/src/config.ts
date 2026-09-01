// Same env-config convention as `apps/agent/src/config.ts` — this daemon is
// a genuinely separate process/deploy unit (spec §8: "two separate
// daemons, different trust levels, different failure domains"), so this is
// a copy adapted for this daemon's own env vars, not a shared import.
//
// Lazy (getters, not eagerly-computed fields) — deliberately, unlike
// `apps/agent`'s copy: `bun test` evaluates every test file's module graph
// in one shared process, so an eager `required("CONTROL_PLANE_URL")` at
// import time means whichever test happens to import this module (even
// transitively, e.g. via `session-token-key.ts`) first "locks in" its env
// var value for every other test in the same run. Reading lazily means
// importing this module has no side effect at all; only actually reading a
// property does, at the point of use — which is how every real caller
// already uses it (inside a function body, never at another module's own
// top level except this daemon's real entrypoint, `index.ts`, where the env
// var is always genuinely set in production).
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

export const config = {
  get controlPlaneUrl(): string {
    return required("CONTROL_PLANE_URL");
  },
  get machineToken(): string {
    return process.env.MACHINE_TOKEN ?? "";
  },
  /** Which `AttestationMethod` this daemon authenticates with (docs/spec.md §9) — the tunnel
   * daemon is "just another attested machine identity", so it reuses the exact same
   * attestation methods and endpoint the control agent uses, no new method needed. */
  get attestationMethod(): "join_token" | "managed_identity" {
    return (process.env.ATTESTATION_METHOD ?? "join_token") as "join_token" | "managed_identity";
  },
};
