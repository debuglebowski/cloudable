import { MACHINE_OS_USER } from "@cloudable/contracts";
// ---------------------------------------------------------------------------
// Snapshot inspection: opening, using and closing a read-only session over an
// archived machine's persistent disk.
//
// The shape to keep in mind is that THE GATE RUNS ON EVERY OPERATION, not only
// at open. A session is a row and a cached handle; it is not a capability. So
// `list` and `read` re-ask every question `open` asked — is the snapshot still
// inspectable, is the policy still on, does this person still have standing —
// rather than trusting that they were true a few minutes ago when the session
// started.
//
// That costs a couple of indexed queries per operation and buys the property
// that matters: revoking an elevation stops the reads it was holding open
// immediately, rather than within a minute when the re-authorization sweep next
// runs. The sweep still exists and still closes the session; this makes the
// window between the two harmless instead of merely short.
// ---------------------------------------------------------------------------
import type { CapturedDisk } from "@cloudable/schema";
import { sessions } from "@cloudable/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import type { ProvisioningError, ProvisioningServiceTag } from "../../services/ProvisioningService";
import { DISK_MOUNT_PATH, type SnapshotFilesystem } from "../../snapshot-fs/ext4/filesystem";
import { resolveAccessMethodsEnabled } from "../machine/settings";
import {
  ArchiveDbError,
  InspectionSessionNotFoundError,
  type MachineNotFoundError,
  SnapshotDiskNotReadableError,
  SnapshotEmptyError,
  SnapshotExpiredError,
  SnapshotInspectionDeniedError,
  type SnapshotNotFoundError,
} from "./errors";
import { makeEnvelope } from "./events";
import { isAuthorizedToInspectSnapshot } from "./inspect-authorization";
import { ensureInspectionFilesystem, releaseInspection } from "./inspection-registry";
import { type MachineRow, dbTry, fetchMachine, fetchSnapshot } from "./queries";
import type { SnapshotRow } from "./snapshot";
import { capturedNothing, getSnapshotSubState, restoreUnavailableReason } from "./sub-state";

/** How long an inspection may stay open without being re-opened. Longer than the tunnel's
 * 15 minutes because nothing is holding a socket or a process on the other end — the cost
 * of a long session here is a cached handle, not a live connection to a machine. */
export const INSPECTION_TTL_MS = 30 * 60 * 1000;

/** Where a browser should start. The machine's own home directory, not the disk root. */
export const INSPECTION_ROOT_PATH = `${DISK_MOUNT_PATH}/${MACHINE_OS_USER}`;

export interface OpenInspectionResult {
  sessionId: string;
  snapshotId: string;
  machineId: string;
  rootPath: string;
  expiresAt: Date;
}

/** Everything opening or using an inspection can fail with. `SnapshotNotFoundError` and
 * `MachineNotFoundError` are in here because a cross-org read reports as not-found, and
 * callers map the whole set to status codes in one place. */
type InspectionError =
  | SnapshotEmptyError
  | SnapshotExpiredError
  | SnapshotInspectionDeniedError
  | SnapshotDiskNotReadableError
  | SnapshotNotFoundError
  | MachineNotFoundError
  | ArchiveDbError;

/**
 * The persistent disk out of a snapshot's captured set.
 *
 * `kind: "data"` is the volume mounted at /home. The OS disk is deliberately not read in
 * v1: it carries a partition table this build has no parser for, and it holds the part of
 * a machine that is rebuilt from an image rather than the part that cannot be recreated.
 */
const persistentDiskOf = (snapshot: SnapshotRow): CapturedDisk | undefined =>
  snapshot.capturedDisks.find((disk) => disk.kind === "data");

/**
 * Everything that must be true before a byte is read, asked in one place so that opening
 * a session and using one cannot drift apart.
 *
 * Order matters and follows the same principle as `mintSession`: facts about the OBJECT
 * first (does it exist, is there anything in it, has it expired), then policy, then the
 * person. A caller learns "this snapshot holds nothing" whether or not they would have
 * been allowed to read it, and learns nothing about a snapshot in another org at all.
 */
const authorizeInspection = (input: {
  snapshotId: string;
  orgId: string;
  personId: string;
}): Effect.Effect<
  { snapshot: SnapshotRow; machine: MachineRow; disk: CapturedDisk },
  InspectionError,
  Db
> =>
  Effect.gen(function* () {
    // Org-scoped: another org's snapshot is not-found, never "denied".
    const snapshot = yield* fetchSnapshot(input.snapshotId, input.orgId);

    if (capturedNothing(snapshot)) {
      return yield* Effect.fail(
        new SnapshotEmptyError({
          snapshotId: snapshot.id,
          reason:
            restoreUnavailableReason(snapshot) ??
            "This snapshot records no disks at the provider, so there is nothing to read.",
        }),
      );
    }

    if (getSnapshotSubState(snapshot) === "expired") {
      return yield* Effect.fail(
        new SnapshotExpiredError({
          snapshotId: snapshot.id,
          expiredAt: (snapshot.expiredAt ?? new Date()).toISOString(),
          reason:
            restoreUnavailableReason(snapshot) ?? "This snapshot's retention window has elapsed.",
        }),
      );
    }

    const disk = persistentDiskOf(snapshot);
    if (!disk) {
      return yield* Effect.fail(
        new SnapshotDiskNotReadableError({
          snapshotId: snapshot.id,
          reason:
            "This snapshot captured an OS disk but no persistent volume. Only the persistent volume — the one holding /home — can be browsed.",
        }),
      );
    }

    const machine = yield* fetchMachine(snapshot.machineId, input.orgId);

    const db = yield* Db;
    const accessMethods = yield* resolveAccessMethodsEnabled(db, {
      orgId: machine.orgId,
      templateId: machine.templateId,
      machineId: machine.id,
    }).pipe(
      Effect.mapError((cause) => new ArchiveDbError({ reason: `settings: ${cause.reason}` })),
    );

    if (!accessMethods.value.snapshotInspect) {
      return yield* Effect.fail(
        new SnapshotInspectionDeniedError({
          snapshotId: snapshot.id,
          reason: "Snapshot inspection is turned off for this machine.",
        }),
      );
    }

    const authorized = yield* isAuthorizedToInspectSnapshot(db, {
      personId: input.personId,
      machineId: machine.id,
      ownerPersonId: machine.ownerPersonId,
    }).pipe(Effect.mapError((cause) => new ArchiveDbError({ reason: `elevations: ${cause}` })));

    if (!authorized) {
      return yield* Effect.fail(
        new SnapshotInspectionDeniedError({
          snapshotId: snapshot.id,
          // Says what to do, not just no. An offboarded machine has no owner at all, so
          // for those this is the only route and every requester takes it.
          reason:
            machine.ownerPersonId === null
              ? "This machine's owner was cleared when they were offboarded, so nobody owns it. Request elevated access to it — file recovery is enough — and an approver has to grant that before you can look."
              : "You do not own this machine. Request elevated access to it — file recovery is enough — and an approver has to grant that before you can look.",
        }),
      );
    }

    return { snapshot, machine, disk };
  });

/** Opens a session, recording it the way every other kind of session is recorded. */
export const openInspection = (input: {
  snapshotId: string;
  orgId: string;
  personId: string;
}): Effect.Effect<OpenInspectionResult, InspectionError, Db | EventBus> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const now = new Date();

    const authorized = yield* authorizeInspection(input).pipe(
      // A refusal is evidence, exactly as it is for a live session, and it uses the same
      // event and the same reason-carrying payload rather than a new type.
      Effect.tapError((error) =>
        eventBus
          .publish([
            {
              ...makeEnvelope({
                orgId: input.orgId,
                machineId: null,
                correlationId: input.snapshotId,
                actorType: "person",
                actorId: input.personId,
              }),
              type: "access.session_denied",
              payload: { reason: denialReasonOf(error), method: "snapshot_files" },
            },
          ])
          .pipe(Effect.catchAll(() => Effect.void)),
      ),
    );

    const inserted = yield* dbTry(
      () =>
        db
          .insert(sessions)
          .values({
            orgId: input.orgId,
            machineId: authorized.machine.id,
            personId: input.personId,
            method: "snapshot_files",
            snapshotId: authorized.snapshot.id,
            // The OS user whose files these were. Recorded for the same reason a live
            // session records it — "whose home directory is this" — and NOT as an
            // identity anything runs as: nothing runs here. See `filesystem.ts`.
            osUser: MACHINE_OS_USER,
            startedAt: now,
            // No token: nothing downstream verifies one. A snapshot inspection never
            // reaches a tunnel daemon, so there is nothing to sign a claim for.
            sessionToken: null,
          })
          .returning({ id: sessions.id }),
      "insert_inspection_session",
    );

    const sessionId = inserted[0]?.id;
    if (!sessionId) {
      return yield* Effect.fail(new ArchiveDbError({ reason: "insert_session_returned_no_row" }));
    }

    // The session row is already committed, so a publish failure must not lose it — but
    // it must not pass silently either: a session with no `access.session_started` is a
    // read that happened with no record of it. Collapsed into `ArchiveDbError` the same
    // way every other archive-domain publish is, and died on at the HTTP boundary.
    yield* eventBus
      .publish([
        {
          ...makeEnvelope({
            orgId: input.orgId,
            machineId: authorized.machine.id,
            correlationId: sessionId,
            actorType: "person",
            actorId: input.personId,
          }),
          type: "access.session_started",
          payload: { method: "snapshot_files", osUser: MACHINE_OS_USER },
        },
      ])
      .pipe(
        Effect.mapError(
          (cause) => new ArchiveDbError({ reason: `event_publish_failed: ${cause.reason}` }),
        ),
      );

    return {
      sessionId,
      snapshotId: authorized.snapshot.id,
      machineId: authorized.machine.id,
      rootPath: INSPECTION_ROOT_PATH,
      expiresAt: new Date(now.getTime() + INSPECTION_TTL_MS),
    };
  });

const denialReasonOf = (error: InspectionError): string => {
  switch (error._tag) {
    case "SnapshotEmptyError":
      return "snapshot_empty";
    case "SnapshotExpiredError":
      return "snapshot_expired";
    case "SnapshotDiskNotReadableError":
      return "no_readable_disk";
    case "SnapshotInspectionDeniedError":
      return "elevation_required";
    case "SnapshotNotFoundError":
    case "MachineNotFoundError":
      return "not_found";
    default:
      return "lookup_failed";
  }
};

interface LiveSession {
  id: string;
  snapshotId: string;
  machineId: string;
  startedAt: Date;
}

/** The session row, if it is this caller's and still open and not past its TTL. */
const requireLiveSession = (input: {
  sessionId: string;
  orgId: string;
  personId: string;
}): Effect.Effect<LiveSession, InspectionSessionNotFoundError | ArchiveDbError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* dbTry(
      () =>
        db
          .select({
            id: sessions.id,
            snapshotId: sessions.snapshotId,
            machineId: sessions.machineId,
            startedAt: sessions.startedAt,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, input.sessionId),
              eq(sessions.orgId, input.orgId),
              // A session belongs to the person who opened it. Not "anyone in the org
              // with the id", and not "any admin" — elevation is how someone else gets
              // to look, and it gets them their own session.
              eq(sessions.personId, input.personId),
              eq(sessions.method, "snapshot_files"),
              isNull(sessions.endedAt),
            ),
          )
          .limit(1),
      "fetch_inspection_session",
    );

    const row = rows[0];
    if (!row || !row.snapshotId) {
      return yield* Effect.fail(new InspectionSessionNotFoundError({ sessionId: input.sessionId }));
    }
    if (Date.now() - row.startedAt.getTime() > INSPECTION_TTL_MS) {
      return yield* Effect.fail(new InspectionSessionNotFoundError({ sessionId: input.sessionId }));
    }
    return {
      id: row.id,
      snapshotId: row.snapshotId,
      machineId: row.machineId,
      startedAt: row.startedAt,
    };
  });

/**
 * The filesystem for an open, still-authorized session.
 *
 * Re-authorizes before handing anything back, so a caller physically cannot read through
 * a session whose standing has lapsed: there is no way to get a filesystem except through
 * this function, and no way through it except past the gate.
 */
export const inspectionFilesystem = (input: {
  sessionId: string;
  orgId: string;
  personId: string;
}): Effect.Effect<
  SnapshotFilesystem,
  InspectionError | InspectionSessionNotFoundError | ProvisioningError,
  Db | ProvisioningServiceTag
> =>
  Effect.gen(function* () {
    const session = yield* requireLiveSession(input);
    const authorized = yield* authorizeInspection({
      snapshotId: session.snapshotId,
      orgId: input.orgId,
      personId: input.personId,
    });

    return yield* ensureInspectionFilesystem({
      sessionId: session.id,
      provider: authorized.machine.provider,
      disk: authorized.disk,
    }).pipe(
      // A snapshot row can name a disk the provider no longer has. That is a real state
      // in production right now: rows written before snapshots got unique names point at
      // objects that were later replaced or cleaned up, and the id recorded is all
      // anything has to go on.
      //
      // It is knowable, not a server fault, so it must not surface as a 500 — that tells
      // whoever clicked nothing and reads as "the control plane is broken". Same
      // treatment as a snapshot that captured nothing: refused with a stated reason,
      // greyed out rather than hidden. Only `not_found` is translated; a quota error or a
      // dead credential really is ours and still dies.
      Effect.catchIf(
        (error): error is ProvisioningError => error.reason === "not_found",
        () =>
          Effect.fail(
            new SnapshotDiskNotReadableError({
              snapshotId: authorized.snapshot.id,
              reason: `This snapshot records a disk (${authorized.disk.externalId}) that no longer exists at the provider, so there is nothing left to read. The record and its audit history are permanent, but the data is gone.`,
            }),
          ),
      ),
    );
  });

/** Ends a session: the row, the event, the grant. */
export const closeInspection = (input: {
  sessionId: string;
  orgId: string;
  actor: { actorType: "person" | "system"; actorId: string };
  reason: string;
}): Effect.Effect<void, ArchiveDbError, Db | EventBus | ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const now = new Date();

    const ended = yield* dbTry(
      () =>
        db
          .update(sessions)
          .set({ endedAt: now, terminationReason: input.reason })
          .where(
            and(
              eq(sessions.id, input.sessionId),
              eq(sessions.orgId, input.orgId),
              isNull(sessions.endedAt),
            ),
          )
          .returning({
            machineId: sessions.machineId,
            startedAt: sessions.startedAt,
          }),
      "end_inspection_session",
    );

    // Released whether or not a row was updated: a repeat close must still let go of the
    // handle, and an already-ended session may well be why this was called.
    yield* releaseInspection(input.sessionId);

    const row = ended[0];
    if (!row) return;

    yield* eventBus
      .publish([
        {
          ...makeEnvelope({
            orgId: input.orgId,
            machineId: row.machineId,
            correlationId: input.sessionId,
            ...input.actor,
          }),
          type: "access.session_ended",
          payload: {
            durationSeconds: Math.max(
              0,
              Math.round((now.getTime() - row.startedAt.getTime()) / 1000),
            ),
            reason: input.reason,
          },
        },
      ])
      .pipe(Effect.mapError((cause) => new ArchiveDbError({ reason: `publish: ${cause.reason}` })));
  });
