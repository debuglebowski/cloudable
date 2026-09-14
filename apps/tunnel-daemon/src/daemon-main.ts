// The daemon's real startup path, reached from `index.ts` when the binary is run
// normally (no `--fs-helper`). Split out of `index.ts` so that importing the
// entrypoint does not, by itself, attest and open a tunnel: the same binary
// re-execs itself as the unprivileged file helper (`files-session.ts`), and that
// process has no control-plane credentials at all — `su -` resets the environment,
// so `CONTROL_PLANE_URL` and `MACHINE_TOKEN` are simply gone. Were this module's
// top level still the entrypoint, every file session would spawn a child that
// immediately tried to attest, failed on a missing env var, and exited.
//
// Attest, then hand off to the persistent outbound tunnel connection
// (`connection.ts`) with a real per-session PTY multiplexer
// (`session-manager.ts`) behind it — mirroring `apps/agent/src/index.ts` +
// `poll-report-loop.ts`'s own attest-then-loop-forever structure. Both
// `connection.ts` and `session-manager.ts` were fully built, unit-tested,
// and live-verified independently, but nothing ever actually called
// `runConnectionLoop` from the daemon's real entrypoint before this — the
// compiled binary attested once and then did nothing else, never opening
// the reverse tunnel this daemon is meant to open, so no session could ever attach
// to a machine running it.
import { AttestationRejectedError, attest, currentBearerToken } from "./attestation";
import { config } from "./config";
import { runConnectionLoop, tunnelConnectUrl } from "./connection";
import { createDefaultSessionManagerDeps, createSessionManager } from "./session-manager";

console.log(`cloudable-tunnel-daemon starting, control plane: ${config.controlPlaneUrl}`);

attest()
  .then((session) => {
    console.log(`attested as machine ${session.machineId} (org ${session.orgId})`);

    const sessionManager = createSessionManager(
      createDefaultSessionManagerDeps({
        machineId: session.machineId,
        // `currentBearerToken()` tracks whatever `attest()`'s own cache currently holds —
        // `runConnectionLoop` re-attests on every reconnect (see its own doc comment), so
        // reading the live cache here (rather than closing over this one initial `session`)
        // keeps the session-token-key fetch authenticated with a token that's still valid
        // long after this first attest. Falls back to the initial token only in the
        // impossible-in-practice window before that first cache write has happened.
        getBearerToken: () => currentBearerToken() ?? session.bearerToken,
      }),
    );

    // Never resolves under normal operation (the tunnel stays open, reconnecting
    // with full-jitter backoff on drop — see `connection.ts`'s own doc comment) — this
    // `.then` exists only so a genuinely unexpected rejection (there is currently no
    // `signal` passed here to ever trigger the "aborted" rejection path) still reaches the
    // same `.catch` below instead of becoming an unhandled rejection.
    return runConnectionLoop({
      wsUrl: tunnelConnectUrl(config.controlPlaneUrl),
      sessionManager,
    });
  })
  .catch((error) => {
    if (error instanceof AttestationRejectedError) {
      console.error(`attestation rejected: ${error.reason} — check MACHINE_TOKEN`);
    } else {
      console.error(`tunnel-daemon startup failed: ${String(error)}`);
    }
    process.exit(1);
  });
