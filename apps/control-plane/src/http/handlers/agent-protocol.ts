import * as crypto from "node:crypto";
import type { DomainEvent } from "@cloudable/events";
import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import { MachineService } from "../../domain/machine/MachineService";
import {
  applyActionResults,
  collectPendingActions,
  expireStaleActions,
} from "../../domain/machine/package-actions";
import { EventBus } from "../../services/EventBus";
import { AgentSessionToken } from "../../services/attestation/AgentSessionToken";
import { AttestationRegistryTag } from "../../services/attestation/AttestationMethod";
import { MachineDirectory } from "../../services/attestation/MachineDirectory";
import { Api } from "../api";
import { bearerToken } from "../bearer-token";
import { AgentUnauthorized, AttestRejected } from "../routes/agent-protocol";

/**
 * Attributed to `agent.attestation_failed` when the rejected credential had
 * no decodable claim to attribute it to (`events.org_id` is `NOT NULL` and
 * this failure is, by definition, from a caller we can't identify — the
 * envelope table has no "unknown tenant" concept, and this sentinel is
 * the pragmatic stand-in for one).
 */
const UNATTRIBUTED_ORG_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Builds an envelope + payload for one of the agent-authored event types.
 * `EventBus.publish` overwrites `id`/`recordedAt` regardless of what's
 * passed here (append-only invariant — see `EventBus.ts`), so the values
 * below are placeholders for those two fields only.
 */
const makeEvent = <T extends DomainEvent["type"]>(
  type: T,
  fields: { orgId: string; actorId: string; machineId: string | null },
  payload: Extract<DomainEvent, { type: T }>["payload"],
): DomainEvent =>
  ({
    id: "",
    occurredAt: new Date(),
    recordedAt: new Date(),
    orgId: fields.orgId,
    actorType: "agent",
    actorId: fields.actorId,
    machineId: fields.machineId,
    correlationId: crypto.randomUUID(),
    schemaVersion: 1,
    type,
    payload,
  }) as DomainEvent;

/**
 * Best-effort, in-memory diff of consecutive `/report` bodies per machine,
 * standing in for real diffing against *persisted* last-observed state.
 * Deliberately not durable: it resets on every control-plane restart (so a
 * machine that was already reporting unchanged state re-emits one
 * `machine.state_reported` after a deploy — an acceptable, documented
 * false positive), and it lives in this process only (multiple control-
 * plane replicas would each keep their own). Storing last-observed state
 * durably needs a `packages/schema` column this unit doesn't own; unit 6
 * replaces this with its proper `deriveEvents` pattern. See this unit's PR
 * description.
 */
const lastObserved = new Map<
  string,
  {
    installedPackages: readonly string[];
    openPorts: readonly number[];
    runningAccessMethods: readonly string[];
  }
>();

const arraysEqual = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const detectChange = (
  machineId: string,
  report: {
    installedPackages: readonly string[];
    openPorts: readonly number[];
    runningAccessMethods: readonly string[];
  },
): Record<string, unknown> | null => {
  const previous = lastObserved.get(machineId);
  lastObserved.set(machineId, {
    installedPackages: report.installedPackages,
    openPorts: report.openPorts,
    runningAccessMethods: report.runningAccessMethods,
  });
  if (!previous) return null;

  const changes: Record<string, unknown> = {};
  if (!arraysEqual(previous.installedPackages, report.installedPackages)) {
    changes.installedPackages = { from: previous.installedPackages, to: report.installedPackages };
  }
  if (!arraysEqual(previous.openPorts, report.openPorts)) {
    changes.openPorts = { from: previous.openPorts, to: report.openPorts };
  }
  // `configState.runningAccessMethods` — diffed the
  // same way as `installedPackages`/`openPorts` above: report-over-report equality,
  // surfaced as part of one `machine.state_reported`, never on a no-op report.
  if (!arraysEqual(previous.runningAccessMethods, report.runningAccessMethods)) {
    changes.runningAccessMethods = {
      from: previous.runningAccessMethods,
      to: report.runningAccessMethods,
    };
  }
  return Object.keys(changes).length > 0 ? changes : null;
};

export const AgentProtocolLive = HttpApiBuilder.group(Api, "agent-protocol", (handlers) =>
  handlers
    .handle("attest", ({ payload }) =>
      Effect.gen(function* () {
        const registry = yield* AttestationRegistryTag;
        const sessions = yield* AgentSessionToken;
        const eventBus = yield* EventBus;
        const directory = yield* MachineDirectory;

        const attestation = registry.get(payload.method);
        if (!attestation) {
          return yield* Effect.fail(new AttestRejected({ reason: "unsupported_method" }));
        }

        const claim = yield* attestation.verifyCredential(payload.credential).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              yield* eventBus
                .publish([
                  makeEvent(
                    "agent.attestation_failed",
                    {
                      orgId: error.claimedOrgId ?? UNATTRIBUTED_ORG_ID,
                      actorId: error.claimedMachineId ?? "unknown",
                      machineId: error.claimedMachineId ?? null,
                    },
                    { method: attestation.method, reason: error.reason },
                  ),
                ])
                .pipe(Effect.orDie);
              return yield* Effect.fail(new AttestRejected({ reason: error.reason }));
            }),
          ),
        );

        const machine = yield* directory.findById(claim.machineId);

        const rejectionReason = !machine
          ? "machine_not_found"
          : machine.orgId !== claim.orgId
            ? "org_mismatch"
            : machine.state.startsWith("archived")
              ? "machine_archived"
              : null;

        if (rejectionReason !== null) {
          yield* eventBus
            .publish([
              makeEvent(
                "agent.attestation_failed",
                { orgId: claim.orgId, actorId: claim.machineId, machineId: claim.machineId },
                { method: attestation.method, reason: rejectionReason },
              ),
            ])
            .pipe(Effect.orDie);
          return yield* Effect.fail(new AttestRejected({ reason: rejectionReason }));
        }

        const { token, expiresAt } = sessions.mint(claim);

        yield* eventBus
          .publish([
            makeEvent(
              "agent.attested",
              { orgId: claim.orgId, actorId: claim.machineId, machineId: claim.machineId },
              { method: attestation.method },
            ),
          ])
          .pipe(Effect.orDie);

        return {
          bearerToken: token,
          expiresAt: expiresAt.toISOString(),
          orgId: claim.orgId,
          machineId: claim.machineId,
        };
      }),
    )
    .handle("poll", ({ request }) =>
      Effect.gen(function* () {
        const sessions = yield* AgentSessionToken;

        const token = bearerToken(request.headers.authorization);
        if (!token) {
          return yield* Effect.fail(new AgentUnauthorized({ reason: "missing_bearer_token" }));
        }
        const identity = yield* sessions
          .verify(token)
          .pipe(Effect.mapError((error) => new AgentUnauthorized({ reason: error.reason })));

        const machineService = yield* MachineService;
        const db = yield* Db;

        const desired = yield* machineService
          .desiredStateFor(identity.machineId, identity.orgId)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!desired) {
          return yield* Effect.fail(new AgentUnauthorized({ reason: "machine_not_found" }));
        }

        const etag = `"${desired.version}"`;

        // A 304 must not swallow work. Collecting below is a write, so the
        // early return is only safe because a new action always bumps
        // `desiredStateVersion` in the same transaction that inserts it —
        // meaning an unchanged ETag really does mean "nothing to collect".
        if (request.headers["if-none-match"] === etag) {
          return HttpServerResponse.empty({ status: 304, headers: { etag } });
        }

        const collected = yield* collectPendingActions(db, identity.machineId, new Date()).pipe(
          Effect.catchAll(() => Effect.succeed([])),
        );

        return HttpServerResponse.unsafeJson(
          {
            version: desired.version,
            packages: desired.allowedPackages,
            settings: {},
            pendingActions: collected.map((row) => ({
              id: row.id,
              op: row.op,
              packageName: row.packageName,
              versionPin: row.versionPin,
            })),
          },
          { status: 200, headers: { etag } },
        );
      }),
    )
    .handle("report", ({ payload, request }) =>
      Effect.gen(function* () {
        const sessions = yield* AgentSessionToken;
        const eventBus = yield* EventBus;
        const directory = yield* MachineDirectory;

        const token = bearerToken(request.headers.authorization);
        if (!token) {
          return yield* Effect.fail(new AgentUnauthorized({ reason: "missing_bearer_token" }));
        }
        const identity = yield* sessions
          .verify(token)
          .pipe(Effect.mapError((error) => new AgentUnauthorized({ reason: error.reason })));

        const machine = yield* directory.findById(identity.machineId);
        if (!machine || machine.orgId !== identity.orgId) {
          return yield* Effect.fail(new AgentUnauthorized({ reason: "machine_not_found" }));
        }

        // Sleeping machines: never fake liveness. `lastVerifiedAt` records the
        // moment the control plane actually heard from this machine, not when it wakes up
        // claiming to.
        const wasFirstSeen = machine.lastVerifiedAt === null;
        const now = new Date();

        yield* directory.markVerified(machine.id, now);

        // Only when the machine actually measured it. An absent field means the agent
        // could not look, which must not be recorded as a measurement of zero.
        if (payload.volumeUsage) {
          yield* directory.recordVolumeUsage(machine.id, payload.volumeUsage, now);
        }

        const identityFields = {
          orgId: identity.orgId,
          actorId: identity.machineId,
          machineId: identity.machineId,
        };

        const db = yield* Db;
        const machineService = yield* MachineService;

        // Persist the inventory, and capture the baseline on the very first
        // report. The baseline is what the image shipped with: written once,
        // never rewritten, so a package later removed from the image still
        // reads as part of what it came with — which it was.
        yield* machineService
          .recordReportedPackages({
            machineId: machine.id,
            installedPackages: payload.installedPackages,
            declaredPackageVersions: payload.declaredPackageVersions,
            captureBaseline: wasFirstSeen,
            observedAt: now,
          })
          .pipe(Effect.catchAll(() => Effect.void));

        // Close out the actions this agent just ran, then give up on anything
        // it collected and never mentioned. The agent tells us what happened;
        // the events below are ours to write (invariant 12).
        const finished = yield* applyActionResults(
          db,
          machine.id,
          (payload.actionResults ?? []).map((result) => ({
            id: result.id,
            outcome: result.outcome,
            detail: result.detail,
          })),
          now,
        ).pipe(Effect.catchAll(() => Effect.succeed([])));

        const expired = yield* expireStaleActions(db, machine.id, now).pipe(
          Effect.catchAll(() => Effect.succeed([])),
        );

        const versionByAction = new Map(
          (payload.actionResults ?? []).map((result) => [result.id, result.installedVersion]),
        );

        const actionEvents: DomainEvent[] = [
          ...finished.map((row) =>
            row.status === "succeeded"
              ? makeEvent("machine.package_action_completed", identityFields, {
                  actionId: row.id,
                  packageName: row.packageName,
                  op: row.op,
                  installedVersion: versionByAction.get(row.id) ?? null,
                })
              : makeEvent("machine.package_action_failed", identityFields, {
                  actionId: row.id,
                  packageName: row.packageName,
                  op: row.op,
                  reason: row.failureReason ?? "the package manager reported a failure",
                  expired: false,
                }),
          ),
          ...expired.map((row) =>
            makeEvent("machine.package_action_failed", identityFields, {
              actionId: row.id,
              packageName: row.packageName,
              op: row.op,
              reason: "the agent collected this action and never reported back",
              expired: true,
            }),
          ),
        ];
        if (actionEvents.length > 0) {
          yield* eventBus.publish(actionEvents).pipe(Effect.orDie);
        }

        if (wasFirstSeen) {
          yield* eventBus
            .publish([
              makeEvent("machine.first_seen", identityFields, {
                agentVersion: payload.agentVersion,
              }),
            ])
            .pipe(Effect.orDie);
        } else {
          const changes = detectChange(identity.machineId, {
            installedPackages: payload.installedPackages,
            openPorts: payload.openPorts,
            runningAccessMethods: payload.configState.runningAccessMethods,
          });
          if (changes) {
            yield* eventBus
              .publish([makeEvent("machine.state_reported", identityFields, { changes })])
              .pipe(Effect.orDie);
          }
        }

        return { acknowledged: true as const };
      }),
    ),
);
