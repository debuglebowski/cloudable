// ---------------------------------------------------------------------------
// The live half of a snapshot inspection: the provider grant and the parsed
// filesystem, held in memory for the length of a session.
//
// IN MEMORY ONLY, and that is a rule rather than a convenience. The grant is a
// URL that reads the disk — a cloud credential by any useful definition — and
// invariant 1 says no cloud credential is ever stored. Writing it to a
// `sessions` column would put a working read capability for someone's home
// directory in the database, in the backups, and in anything that reads a row.
//
// Losing it on restart is the acceptable cost, and it is cheap: `ensure()`
// re-grants on the next operation, and the session row plus the access gate
// are what actually decide whether that is allowed. The registry is a cache of
// an expensive handle, never a record of anything.
//
// Single-replica, like `TunnelRegistry` beside it and for the same documented
// reason (`docs/access.md` §4).
// ---------------------------------------------------------------------------
import type { CapturedDisk } from "@cloudable/schema";
import { Effect } from "effect";
import {
  ProvisioningError,
  ProvisioningServiceTag,
  type SnapshotReadGrant,
} from "../../services/ProvisioningService";
import { type SnapshotFilesystem, openExt4Filesystem } from "../../snapshot-fs/ext4/filesystem";
import { cachingReader, httpRangeReader } from "../../snapshot-fs/range-reader";
import { fileRangeReader } from "../../snapshot-fs/range-reader";

/** How long a provider grant is asked for. Longer than a session's own TTL so a session
 * never dies mid-browse waiting on a re-grant, short enough that a leaked URL is not
 * useful for long. */
export const GRANT_DURATION_SECONDS = 60 * 60;

/** Re-granted this long before expiry rather than at it, so a read in flight when the
 * clock runs out does not fail on a URL that died between check and use. */
const GRANT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * How long a grant outlives its last reader before being revoked.
 *
 * Revoking the moment the last session closed looked tidy and was wrong. Azure's
 * `revokeAccess` is still settling when it returns, so a `grantAccess` immediately
 * afterwards hands back a SAS that the in-flight revoke then kills — the next read gets
 * 403. `cloudable snapshots ls` opens, reads and closes, so running it twice hit this
 * every other time. Proven in production: five reads through ONE session succeeded five
 * times, while six separate sessions alternated pass/fail.
 *
 * A grace period fixes it by making the common case reuse a live grant instead of
 * churning one. The capability still dies — within this window of the last reader
 * leaving, and in any case when the grant itself expires.
 */
const RELEASE_GRACE_MS = 5 * 60 * 1000;

interface Entry {
  grant: SnapshotReadGrant;
  filesystem: SnapshotFilesystem;
  provider: "azure" | "docker" | "fake";
  /** Every session currently reading through this grant. The grant is released when the
   * last one goes — after `RELEASE_GRACE_MS`, never immediately. */
  sessionIds: Set<string>;
  /** When the last reader left, or null while any remain. Cleared again if a new session
   * picks the entry up during the grace window, so a grant in active back-to-back use is
   * never revoked out from under it. */
  releasedAt: number | null;
}

/**
 * Keyed by DISK, not by session, and that is the whole point.
 *
 * `revokeAccess` revokes access to the SNAPSHOT — not to one SAS handed out from it. So a
 * grant-per-session registry had every close tear down a capability other sessions might
 * still be using. Two people browsing the same snapshot broke each other, and one closing
 * their tab killed the other's live session. Even alone it failed: closing a session and
 * immediately opening another raced the revoke against the new grant, which is exactly
 * what `cloudable snapshots ls` does twice in a row, and it failed every other time.
 *
 * Sharing one grant per disk and releasing it when the last reader leaves fixes all three,
 * and costs one fewer provider round trip per session as well.
 */
const entries = new Map<string, Entry>();

const readerFor = async (readUrl: string) => {
  // `file://` is what the fake provider serves, so an end-to-end test exercises this
  // registry, the session gate and the ext4 reader against a real image with no cloud.
  const inner = readUrl.startsWith("file://")
    ? await fileRangeReader(readUrl.slice("file://".length))
    : httpRangeReader(readUrl);
  return cachingReader(inner);
};

/**
 * The filesystem for `sessionId`, granting access on first use and re-granting when the
 * existing grant is close to expiry.
 *
 * Callers must have authorized the session FIRST. Nothing here checks permissions — it
 * is deliberately a dumb handle cache, so that there is exactly one place (`inspect.ts`)
 * where the question "may this person read this" is asked and answered.
 */
export const ensureInspectionFilesystem = (input: {
  sessionId: string;
  provider: "azure" | "docker" | "fake";
  disk: CapturedDisk;
}): Effect.Effect<SnapshotFilesystem, ProvisioningError, ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const existing = entries.get(input.disk.externalId);
    if (existing && existing.grant.expiresAt.getTime() - Date.now() > GRANT_REFRESH_MARGIN_MS) {
      existing.sessionIds.add(input.sessionId);
      // Back in use — cancels any pending release.
      existing.releasedAt = null;
      return existing.filesystem;
    }

    const provisioning = yield* ProvisioningServiceTag;
    const grant = yield* provisioning.grantSnapshotRead({
      provider: input.provider,
      diskExternalId: input.disk.externalId,
      durationSeconds: GRANT_DURATION_SECONDS,
    });

    const filesystem = yield* Effect.tryPromise({
      try: async () => openExt4Filesystem(await readerFor(grant.readUrl)),
      // An image that will not parse is a provider-shaped failure from the caller's
      // point of view: the bytes are there and are not what we can read. Never
      // surfaced with the parser's own message, which carries byte offsets into
      // someone's disk.
      catch: (cause) => new ProvisioningError({ reason: "provider_error", cause }),
    });

    // Re-granting keeps whoever was already reading: they are about to be moved onto the
    // fresh grant, and dropping them here would revoke the old one out from under them.
    entries.set(input.disk.externalId, {
      grant,
      filesystem,
      provider: input.provider,
      sessionIds: new Set([...(existing?.sessionIds ?? []), input.sessionId]),
      releasedAt: null,
    });
    return filesystem;
  });

/**
 * Marks a session as no longer reading. Does NOT revoke — see `RELEASE_GRACE_MS`.
 *
 * Never fails. Every path that ends a session calls this: the person closing the tab, the
 * re-authorization sweep, a policy change, the expiry daemon.
 */
export const releaseInspection = (
  sessionId: string,
): Effect.Effect<void, never, ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const found = [...entries.entries()].find(([, entry]) => entry.sessionIds.has(sessionId));
    if (!found) return;
    const [diskExternalId, entry] = found;

    entry.sessionIds.delete(sessionId);
    // Someone else is still reading. Revoking now would take the disk out from under
    // them mid-listing — see this file's header.
    if (entry.sessionIds.size > 0) return;

    // Last reader gone, but NOT revoked here. `releaseIdleInspections` does it once the
    // grace window has passed, so the very common open-read-close-open-read sequence
    // reuses one grant instead of racing a revoke against the next grant.
    entry.releasedAt = Date.now();
  });

/**
 * Revokes grants whose last reader left more than `RELEASE_GRACE_MS` ago.
 *
 * Runs on the expiry daemon's pass. An entry picked back up during its grace window has
 * `releasedAt` cleared by `ensureInspectionFilesystem`, so this only ever revokes a grant
 * nothing has touched for the whole window.
 */
export const releaseIdleInspections = (
  now: number = Date.now(),
): Effect.Effect<number, never, ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const due = [...entries.entries()].filter(
      ([, entry]) => entry.releasedAt !== null && now - entry.releasedAt >= RELEASE_GRACE_MS,
    );
    if (due.length === 0) return 0;

    const provisioning = yield* ProvisioningServiceTag;
    for (const [diskExternalId, entry] of due) {
      entries.delete(diskExternalId);
      yield* provisioning
        .revokeSnapshotRead({ provider: entry.provider, diskExternalId })
        .pipe(Effect.catchAll(() => Effect.void));
    }
    return due.length;
  });

/** Session ids currently reading through a grant, across every disk. */
export const heldInspectionSessionIds = (): string[] =>
  [...entries.values()].flatMap((entry) => [...entry.sessionIds]);
