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

interface Entry {
  grant: SnapshotReadGrant;
  filesystem: SnapshotFilesystem;
  provider: "azure" | "docker" | "fake";
  /** Every session currently reading through this grant. The grant is released when the
   * last one goes, never before. */
  sessionIds: Set<string>;
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
    });
    return filesystem;
  });

/**
 * Drops the handle and revokes the grant at the provider.
 *
 * Never fails. Every path that ends a session calls this — the person closing the tab,
 * the re-authorization sweep, a policy change, the expiry daemon — and a close path that
 * can throw leaves the grant open, which is the opposite of what it is for.
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

    entries.delete(diskExternalId);
    const provisioning = yield* ProvisioningServiceTag;
    yield* provisioning
      .revokeSnapshotRead({ provider: entry.provider, diskExternalId })
      .pipe(Effect.catchAll(() => Effect.void));
  });

/** Session ids currently reading through a grant, across every disk. */
export const heldInspectionSessionIds = (): string[] =>
  [...entries.values()].flatMap((entry) => [...entry.sessionIds]);
