// ---------------------------------------------------------------------------
// CLAUDE.md invariant #8: "Cloudable injects secrets, never stores them."
//
// `injectSecretsForSession` is the standalone fetch-and-inject function that
// unit 12's session-start logic (web terminal / tunnel session) is expected
// to call once it has resolved which `secretBindings` apply to a session,
// and turned each row into a `SecretRef`.
//
// The map this returns MUST NEVER be:
//   - written to disk (no file, no snapshot, no cache)
//   - persisted to any database table — including `secretBindings`, which
//     stores only the pointer/reference metadata (see
//     `packages/schema/src/tables/secret-binding.ts`), never a fetched value
//   - logged, traced, included in an error message, or returned over the
//     wire to anything other than the live session process
// Callers must hold it only in memory for the session's lifetime and let it
// be garbage-collected once the session ends. See
// `apps/control-plane/src/services/secrets/inject.invariant8.test.ts` for
// the explicit test asserting no disk/DB write happens on this path.
// ---------------------------------------------------------------------------
import { Effect } from "effect";
import type { SecretRef } from "../SecretsProvider";
import { SecretsProviderTag } from "../SecretsProvider";

/**
 * Stable key for a `SecretRef` within the map `injectSecretsForSession`
 * returns. Bare `SecretRef`s carry no separate "name" — the caller (which
 * already has the originating `secretBindings` row, including its `key`
 * column) is expected to look up this same `${provider}:${pointer}` string
 * to know which fetched value corresponds to which binding.
 */
export const secretRefKey = (ref: SecretRef): string => `${ref.provider}:${ref.pointer}`;

/**
 * Fetches every bound secret for a session via the configured
 * `SecretsProvider` and returns them as an in-memory map (see
 * `secretRefKey` for how entries are keyed) for the caller to inject
 * directly into a live terminal/SSH session's environment. Never persists,
 * logs, or otherwise durably stores anything it fetches.
 */
export const injectSecretsForSession = (
  bindings: ReadonlyArray<SecretRef>,
): Effect.Effect<Record<string, string>, Error, SecretsProviderTag> =>
  Effect.gen(function* () {
    const provider = yield* SecretsProviderTag;
    const entries = yield* Effect.forEach(
      bindings,
      (ref) => Effect.map(provider.fetch(ref), (value) => [secretRefKey(ref), value] as const),
      { concurrency: "unbounded" },
    );
    return Object.fromEntries(entries);
  });
