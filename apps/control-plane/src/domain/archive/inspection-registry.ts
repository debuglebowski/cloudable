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
  diskExternalId: string;
}

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
    const existing = entries.get(input.sessionId);
    if (
      existing &&
      existing.diskExternalId === input.disk.externalId &&
      existing.grant.expiresAt.getTime() - Date.now() > GRANT_REFRESH_MARGIN_MS
    ) {
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

    entries.set(input.sessionId, {
      grant,
      filesystem,
      provider: input.provider,
      diskExternalId: input.disk.externalId,
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
    const entry = entries.get(sessionId);
    if (!entry) return;
    entries.delete(sessionId);

    const provisioning = yield* ProvisioningServiceTag;
    yield* provisioning
      .revokeSnapshotRead({ provider: entry.provider, diskExternalId: entry.diskExternalId })
      .pipe(Effect.catchAll(() => Effect.void));
  });

/** Session ids currently holding a grant — the expiry daemon's input for finding
 * handles whose session has since ended. */
export const heldInspectionSessionIds = (): string[] => [...entries.keys()];
