// ---------------------------------------------------------------------------
// Approved apt repositories: package sources outside Ubuntu's own that an org
// has decided to trust (first use: NodeSource, for Node 24).
//
// Adding or removing one is an approved, recorded decision: an `apt_repository`
// approval, mode on the Organisation page, default one approver. The row is
// written only once that is granted, and never deleted; removing sets
// `removedAt`. A repository installs nothing by itself: packages from it are
// ordinary apt manifest entries with the usual Allowed / Ensure settings
// (CLAUDE.md invariants 4 and 5).
//
// Every live machine in the org gets the change on its next poll
// (`settings.aptRepositories`); the agent writes or removes
// `/etc/apt/sources.list.d/cloudable-<id>.sources` and its key, and reports what
// it has in place. Apt sources a machine has that neither Ubuntu nor this list
// explains are drift (`undeclaredAptSources`).
// ---------------------------------------------------------------------------
import {
  APT_COMPONENT_PATTERN,
  APT_SUITE_PATTERN,
  type AptRepository,
  type AptRepositoryConfig,
  type AptSourceReport,
  UBUNTU_APT_HOST_PATTERN,
} from "@cloudable/contracts";
import type { MachineEvent, OrgEvent } from "@cloudable/events";
import { aptRepositories, machines } from "@cloudable/schema";
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { type Context, Effect, Schema } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { type ApprovalResult, ApprovalService } from "../../services/ApprovalService";
import { EventBus } from "../../services/EventBus";
import { readMalwareProtectionWith } from "./malware-protection";
import { openPgpFingerprint } from "./openpgp-fingerprint";

type DbHandle = Context.Tag.Service<typeof Db>;
type Row = typeof aptRepositories.$inferSelect;

export class AptRepositoryError extends Schema.TaggedError<AptRepositoryError>()(
  "AptRepositoryError",
  {
    code: Schema.Literal(
      "invalid_apt_repository",
      "apt_repository_not_found",
      "apt_repository_name_taken",
      "reason_required",
    ),
    message: Schema.String,
  },
) {}

const invalid = (message: string) =>
  Effect.fail(new AptRepositoryError({ code: "invalid_apt_repository", message }));

/** What an add request carries, checked and with its key's fingerprint. Stored on the approval. */
const RepositorySpec = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  suite: Schema.String,
  components: Schema.Array(Schema.String),
  signingKey: Schema.String,
  fingerprint: Schema.String,
});

const Payload = Schema.Union(
  Schema.Struct({ op: Schema.Literal("add"), repository: RepositorySpec }),
  Schema.Struct({
    op: Schema.Literal("remove"),
    repositoryId: Schema.String,
    name: Schema.String,
    fingerprint: Schema.String,
  }),
);
type Payload = Schema.Schema.Type<typeof Payload>;
const decodePayload = Schema.decodeUnknownOption(Payload);

const toWire = (row: Row): AptRepository => ({
  id: row.id,
  name: row.name,
  url: row.url,
  suite: row.suite,
  components: row.components,
  fingerprint: row.fingerprint,
  addedAt: row.addedAt.toISOString(),
  removedAt: row.removedAt ? row.removedAt.toISOString() : null,
});

const dbTry = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new Error(`${message}: ${String(cause)}`) });

/** Every repository the org has had, active first, then removed ones. */
export const listAptRepositories = (orgId: string): Effect.Effect<AptRepository[], Error, Db> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* dbTry("listing apt repositories", () =>
      db
        .select()
        .from(aptRepositories)
        .where(eq(aptRepositories.orgId, orgId))
        .orderBy(asc(aptRepositories.name)),
    );
    return rows
      .map(toWire)
      .sort((a, b) => Number(a.removedAt !== null) - Number(b.removedAt !== null));
  });

const activeRows = (db: DbHandle, orgId: string) =>
  dbTry("reading apt repositories", () =>
    db
      .select()
      .from(aptRepositories)
      .where(and(eq(aptRepositories.orgId, orgId), isNull(aptRepositories.removedAt))),
  );

/** What the poll carries: the org's active repositories, for the agent to write. */
export const aptRepositoryConfigsFor = (
  db: DbHandle,
  orgId: string,
): Effect.Effect<AptRepositoryConfig[], Error> =>
  Effect.map(activeRows(db, orgId), (rows) =>
    rows.map((row) => ({
      id: row.id,
      url: row.url,
      suite: row.suite,
      components: row.components,
      signingKey: row.signingKey,
      fingerprint: row.fingerprint,
    })),
  );

/** Checks a request and computes its key's fingerprint. Exported for tests. */
export const checkRepositorySpec = (input: {
  name: string;
  url: string;
  suite: string;
  components: ReadonlyArray<string>;
  signingKey: string;
}) =>
  Effect.gen(function* () {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 100) {
      return yield* invalid("a repository needs a name of up to 100 characters");
    }
    const url = input.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return yield* invalid(`"${url}" is not a URL`);
    }
    if (parsed.protocol !== "https:" || /\s/.test(url)) {
      return yield* invalid("the repository URL must be https, with no spaces");
    }
    const suite = input.suite.trim();
    if (!APT_SUITE_PATTERN.test(suite)) return yield* invalid(`"${suite}" is not an apt suite`);
    const components = input.components.map((c) => c.trim()).filter((c) => c !== "");
    if (components.length === 0) return yield* invalid("give at least one component, e.g. main");
    for (const component of components) {
      if (!APT_COMPONENT_PATTERN.test(component)) {
        return yield* invalid(`"${component}" is not an apt component`);
      }
    }
    const signingKey = `${input.signingKey.replace(/\r\n/g, "\n").trim()}\n`;
    const fingerprint = openPgpFingerprint(signingKey);
    if (!fingerprint) {
      return yield* invalid(
        "the signing key must be one ASCII-armored OpenPGP public key (BEGIN PGP PUBLIC KEY BLOCK)",
      );
    }
    return { name, url, suite, components, signingKey, fingerprint };
  });

const requestApproval = (input: {
  orgId: string;
  personId: string;
  reason: string;
  payload: Payload;
}) =>
  Effect.gen(function* () {
    if (!input.reason.trim()) {
      return yield* Effect.fail(
        new AptRepositoryError({ code: "reason_required", message: "say why, for the approver" }),
      );
    }
    const approvalService = yield* ApprovalService;
    return yield* approvalService
      .request({
        orgId: input.orgId,
        actionType: "apt_repository",
        requestedByPersonId: input.personId,
        targetMachineId: null,
        reason: input.reason,
        payload: input.payload,
      })
      .pipe(Effect.orDie);
  });

/**
 * Asks to add a repository. Nothing is written until the approval is granted, unless the
 * org's mode for `apt_repository` is `none`, in which case it applies at once.
 */
export const requestAptRepositoryAdd = (input: {
  orgId: string;
  personId: string;
  name: string;
  url: string;
  suite: string;
  components: ReadonlyArray<string>;
  signingKey: string;
  reason: string;
}) =>
  Effect.gen(function* () {
    const spec = yield* checkRepositorySpec(input);
    const db = yield* Db;
    const active = yield* activeRows(db, input.orgId).pipe(Effect.orDie);
    if (active.some((row) => row.name === spec.name)) {
      return yield* Effect.fail(
        new AptRepositoryError({
          code: "apt_repository_name_taken",
          message: `a repository named "${spec.name}" is already approved`,
        }),
      );
    }
    const approval = yield* requestApproval({
      orgId: input.orgId,
      personId: input.personId,
      reason: input.reason,
      payload: { op: "add", repository: spec },
    });
    if (approval.status === "approved") yield* applyApprovedAptRepositoryChange(approval);
    return { approvalId: approval.id, status: approval.status, fingerprint: spec.fingerprint };
  });

/** Asks to remove one. Packages installed from it stay installed. */
export const requestAptRepositoryRemove = (input: {
  orgId: string;
  personId: string;
  repositoryId: string;
  reason: string;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const active = yield* activeRows(db, input.orgId).pipe(Effect.orDie);
    const row = active.find((r) => r.id === input.repositoryId);
    if (!row) {
      return yield* Effect.fail(
        new AptRepositoryError({
          code: "apt_repository_not_found",
          message: "no approved repository with that id in this org",
        }),
      );
    }
    const approval = yield* requestApproval({
      orgId: input.orgId,
      personId: input.personId,
      reason: input.reason,
      payload: { op: "remove", repositoryId: row.id, name: row.name, fingerprint: row.fingerprint },
    });
    if (approval.status === "approved") yield* applyApprovedAptRepositoryChange(approval);
    return { approvalId: approval.id, status: approval.status };
  });

/** Every live machine in the org re-reads its poll body, which now carries the change. */
const bumpOrgMachines = (db: DbHandle, orgId: string) =>
  dbTry("notifying machines", () =>
    db
      .update(machines)
      .set({ desiredStateVersion: sql`${machines.desiredStateVersion} + 1` })
      .where(
        and(
          eq(machines.orgId, orgId),
          notInArray(machines.state, ["archived_restorable", "archived_expired"]),
        ),
      ),
  );

const orgEvent = (approval: ApprovalResult, event: Pick<OrgEvent, "type" | "payload">): OrgEvent =>
  ({
    id: "",
    occurredAt: new Date(),
    recordedAt: new Date(0),
    orgId: approval.orgId,
    // The admin who asked. The approver is on the approval's own `approval.granted` event.
    actorType: "person",
    actorId: approval.requestedByPersonId,
    machineId: null,
    correlationId: ulid(),
    schemaVersion: 1,
    ...event,
  }) as OrgEvent;

/**
 * Writes a granted change. Called once per approval by `domain/approvals/carry-out.ts`, or
 * straight away when the org's mode is `none`. Never fails its caller: the approval stands
 * either way, and a failure is logged.
 */
export const applyApprovedAptRepositoryChange = (
  approval: ApprovalResult,
): Effect.Effect<void, never, Db | EventBus> =>
  Effect.gen(function* () {
    const decoded = decodePayload(approval.payload);
    if (decoded._tag === "None") {
      return yield* Effect.logError(`approval ${approval.id}: apt_repository payload unreadable`);
    }
    const payload = decoded.value;
    const db = yield* Db;
    const eventBus = yield* EventBus;
    if (payload.op === "add") {
      const spec = payload.repository;
      const inserted = yield* dbTry("adding apt repository", () =>
        db
          .insert(aptRepositories)
          .values({
            orgId: approval.orgId,
            name: spec.name,
            url: spec.url,
            suite: spec.suite,
            components: [...spec.components],
            signingKey: spec.signingKey,
            fingerprint: spec.fingerprint,
            addApprovalId: approval.id,
          })
          .returning(),
      );
      const row = inserted[0];
      if (!row) return yield* Effect.fail(new Error("adding apt repository: no row"));
      yield* eventBus.publish([
        orgEvent(approval, {
          type: "org.apt_repository_added",
          payload: {
            repositoryId: row.id,
            name: row.name,
            url: row.url,
            suite: row.suite,
            components: row.components,
            fingerprint: row.fingerprint,
            approvalId: approval.id,
          },
        }),
      ]);
    } else {
      const updated = yield* dbTry("removing apt repository", () =>
        db
          .update(aptRepositories)
          .set({ removedAt: new Date(), removeApprovalId: approval.id })
          .where(
            and(
              eq(aptRepositories.id, payload.repositoryId),
              eq(aptRepositories.orgId, approval.orgId),
              isNull(aptRepositories.removedAt),
            ),
          )
          .returning(),
      );
      // Already removed by an earlier approval: nothing changed, nothing to record.
      if (updated.length === 0) return;
      yield* eventBus.publish([
        orgEvent(approval, {
          type: "org.apt_repository_removed",
          payload: {
            repositoryId: payload.repositoryId,
            name: payload.name,
            fingerprint: payload.fingerprint,
            approvalId: approval.id,
          },
        }),
      ]);
    }
    yield* bumpOrgMachines(db, approval.orgId);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError(
        `approval ${approval.id}: granted, but the apt repository change was not written: ${String(error)}`,
      ),
    ),
  );

/**
 * The apt sources on a machine that nothing explains: not Ubuntu's own archives, not one
 * of the org's approved repositories (matched by its `cloudable-<id>` file and its URL),
 * and not Microsoft's package feed while the org has Defender turned on (the Defender
 * extension adds it). Returned as URIs, sorted and unique, for the drift record.
 */
export function undeclaredAptSources(
  sources: ReadonlyArray<AptSourceReport>,
  approved: ReadonlyArray<Pick<AptRepositoryConfig, "id" | "url">>,
  options: { malwareProtection: boolean },
): string[] {
  const out = new Set<string>();
  for (const source of sources) {
    let host: string;
    try {
      host = new URL(source.uri).hostname.toLowerCase();
    } catch {
      out.add(source.uri);
      continue;
    }
    if (UBUNTU_APT_HOST_PATTERN.test(host)) continue;
    if (options.malwareProtection && host === "packages.microsoft.com") continue;
    const fileName = source.file.split("/").pop() ?? "";
    const repo = approved.find((r) => fileName === `cloudable-${r.id}.sources`);
    if (repo && trimSlash(repo.url) === trimSlash(source.uri)) continue;
    out.add(source.uri);
  }
  return [...out].sort();
}

const trimSlash = (uri: string) => uri.replace(/\/+$/, "");

/**
 * Stores what the agent reported about apt, and records what changed (invariant 12: the
 * agent reports state, the control plane derives events):
 *
 * - each approved repository newly in place, or gone: `machine.apt_repository_configured`
 *   / `machine.apt_repository_removed`;
 * - the set of unexplained apt sources changing: `machine.drift_detected` with
 *   `undeclaredAptSources`, or `machine.drift_resolved` with `removedAptSources` once
 *   there are none.
 *
 * Nothing happens when the agent sent neither field (an older agent, or no apt).
 */
export const recordReportedAptState = (
  db: DbHandle,
  input: {
    orgId: string;
    machineId: string;
    aptSources: ReadonlyArray<AptSourceReport> | undefined;
    aptRepositoryIds: ReadonlyArray<string> | undefined;
  },
): Effect.Effect<void, Error, EventBus> =>
  Effect.gen(function* () {
    if (input.aptSources === undefined && input.aptRepositoryIds === undefined) return;
    const rows = yield* dbTry("reading machine apt state", () =>
      db
        .select({
          aptRepositoryIds: machines.aptRepositoryIds,
          undeclaredAptSources: machines.undeclaredAptSources,
        })
        .from(machines)
        .where(eq(machines.id, input.machineId))
        .limit(1),
    );
    const previous = rows[0];
    if (!previous) return;

    const approved = yield* aptRepositoryConfigsFor(db, input.orgId);
    const malware = yield* readMalwareProtectionWith(db, input.orgId);
    const undeclared =
      input.aptSources === undefined
        ? (previous.undeclaredAptSources ?? null)
        : undeclaredAptSources(input.aptSources, approved, {
            malwareProtection: malware === "defender",
          });
    const ids = input.aptRepositoryIds ? [...input.aptRepositoryIds].sort() : null;

    const envelope = {
      id: "",
      occurredAt: new Date(),
      recordedAt: new Date(0),
      orgId: input.orgId,
      actorType: "agent" as const,
      actorId: input.machineId,
      machineId: input.machineId,
      correlationId: ulid(),
      schemaVersion: 1,
    };
    const events: MachineEvent[] = [];
    if (ids !== null) {
      const before = new Set(previous.aptRepositoryIds ?? []);
      const after = new Set(ids);
      for (const id of ids) {
        if (!before.has(id)) {
          events.push({
            ...envelope,
            type: "machine.apt_repository_configured",
            payload: { repositoryId: id },
          });
        }
      }
      for (const id of before) {
        if (!after.has(id)) {
          events.push({
            ...envelope,
            type: "machine.apt_repository_removed",
            payload: { repositoryId: id },
          });
        }
      }
    }
    if (undeclared !== null) {
      const before = previous.undeclaredAptSources ?? [];
      const changed = before.join("\n") !== undeclared.join("\n");
      if (changed && undeclared.length > 0) {
        events.push({
          ...envelope,
          type: "machine.drift_detected",
          payload: {
            undeclaredPackages: [],
            undeclaredPorts: [],
            undeclaredAptSources: undeclared,
          },
        });
      } else if (changed && before.length > 0) {
        events.push({
          ...envelope,
          type: "machine.drift_resolved",
          payload: { removed: [], approvalId: null, removedAptSources: before },
        });
      }
    }

    yield* dbTry("storing machine apt state", () =>
      db
        .update(machines)
        .set({
          ...(input.aptSources !== undefined
            ? { aptSources: input.aptSources.map((s) => ({ file: s.file, uri: s.uri })) }
            : {}),
          ...(ids !== null ? { aptRepositoryIds: ids } : {}),
          ...(undeclared !== null ? { undeclaredAptSources: undeclared } : {}),
        })
        .where(eq(machines.id, input.machineId)),
    );
    if (events.length > 0) {
      const eventBus = yield* EventBus;
      yield* eventBus.publish(events).pipe(Effect.mapError((e) => new Error(String(e.reason))));
    }
  });
