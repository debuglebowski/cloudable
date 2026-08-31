import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "@cloudable/events";
import type { SettingRow } from "@cloudable/schema";
import { Effect, Layer } from "effect";
import {
  ApprovalError,
  type ApprovalRequest,
  type ApprovalResult,
  ApprovalService,
} from "../../services/ApprovalService";
import { EventBus, type EventBusError } from "../../services/EventBus";
import {
  type ElevationRepo,
  ElevationRepoTag,
  type InsertElevationValues,
  type MachineRecord,
  type PersonRecord,
} from "./ElevationRepo";
import { ElevationService } from "./ElevationService";
import { ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY, ADMIN_ACCESS_POLICY_SETTING_KEY } from "./policy";
import type { Elevation } from "./types";
import {
  ElevationPolicyDeniedError,
  ElevationStateError,
  MachineNotFoundError,
  PersonNotFoundError,
  SelfOwnedMachineError,
} from "./types";

/**
 * `ElevationService` is tested against in-memory fakes for every dependency
 * (`ElevationRepo`, `EventBus`, `ApprovalService`) rather than a real
 * Postgres — per the standard worker instructions ("colocated unit tests,
 * mocking ApprovalService"), extended here to the persistence port too
 * because a `PostgreSqlContainer`-backed test hangs indefinitely under Bun
 * in this sandbox (upstream bug: `oven-sh/bun#21342` /
 * `testcontainers-node#974` — confirmed by a sibling unit). The real,
 * Drizzle-backed `ElevationRepoLive` is instead exercised by this unit's
 * E2E verification against the docker-compose Postgres (see the PR
 * description).
 */

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

interface Seed {
  orgId: string;
  ownerPersonId: string;
  adminPersonId: string;
  outsiderPersonId: string;
  deactivatedPersonId: string;
  machineId: string;
}

function seed(): Seed {
  return {
    orgId: nextId("org"),
    ownerPersonId: nextId("owner"),
    adminPersonId: nextId("admin"),
    outsiderPersonId: nextId("outsider-org-person"),
    deactivatedPersonId: nextId("deactivated"),
    machineId: nextId("machine"),
  };
}

/** In-memory `ElevationRepo` fake, pre-seeded with one org/machine/owner/admin. */
function makeFakeRepo(s: Seed) {
  const machinesById = new Map<string, MachineRecord>([
    [
      s.machineId,
      { id: s.machineId, orgId: s.orgId, templateId: null, ownerPersonId: s.ownerPersonId },
    ],
  ]);
  const peopleById = new Map<string, PersonRecord>([
    [s.ownerPersonId, { id: s.ownerPersonId, orgId: s.orgId, active: true }],
    [s.adminPersonId, { id: s.adminPersonId, orgId: s.orgId, active: true }],
    [s.outsiderPersonId, { id: s.outsiderPersonId, orgId: nextId("other-org"), active: true }],
    [s.deactivatedPersonId, { id: s.deactivatedPersonId, orgId: s.orgId, active: false }],
  ]);
  const settingRows: SettingRow<unknown>[] = [];
  const elevationsById = new Map<string, Elevation>();

  function setSetting(key: string, value: unknown) {
    settingRows.push({ scopeType: "org", scopeId: s.orgId, key, value, source: "org" });
  }

  const repo: ElevationRepo = {
    findMachine: (machineId) => Effect.succeed(machinesById.get(machineId) ?? null),
    findPerson: (personId) => Effect.succeed(peopleById.get(personId) ?? null),
    findElevation: (elevationId) => Effect.succeed(elevationsById.get(elevationId) ?? null),
    // The fake ignores `scopeIds` (the narrowing `ElevationRepoLive` does for
    // real) since this in-memory dataset is already scoped to one org by
    // construction; `resolveSetting`'s own org/template/machine precedence
    // is covered separately by `policy.test.ts`.
    findSettingRows: () => Effect.succeed(settingRows),
    insertElevation: (values: InsertElevationValues) => {
      const elevation: Elevation = { id: nextId("elevation"), ...values };
      elevationsById.set(elevation.id, elevation);
      return Effect.succeed(elevation);
    },
    updateElevationGranted: (elevationId, grantedAt, expiresAt) => {
      const existing = elevationsById.get(elevationId);
      if (!existing) return Effect.fail(new Error(`no such elevation: ${elevationId}`));
      const updated: Elevation = { ...existing, status: "granted", grantedAt, expiresAt };
      elevationsById.set(elevationId, updated);
      return Effect.succeed(updated);
    },
    updateElevationStatus: (elevationId, status) => {
      const existing = elevationsById.get(elevationId);
      if (!existing) return Effect.fail(new Error(`no such elevation: ${elevationId}`));
      const updated: Elevation = { ...existing, status };
      elevationsById.set(elevationId, updated);
      return Effect.succeed(updated);
    },
  };

  return { layer: Layer.succeed(ElevationRepoTag, repo), setSetting, elevationsById };
}

/**
 * In-memory `ApprovalService` fake — a test controls each approval's outcome
 * via `setStatus`. Builds full `ApprovalResult` objects (not just `id`/
 * `status`) since that's the real service's return type; the fields beyond
 * `id`/`status` are unused by `ElevationService`'s own logic and are given
 * fixed placeholder values here.
 */
function makeFakeApprovalService() {
  const statuses = new Map<string, ApprovalResult["status"]>();

  const toResult = (id: string, status: ApprovalResult["status"]): ApprovalResult => ({
    id,
    orgId: "fake-org",
    actionType: "admin_access",
    mode: "single",
    status,
    requestedByPersonId: "fake-requester",
    targetMachineId: null,
    reason: "fake",
    requiredApprovals: 1,
    approvedCount: status === "approved" ? 1 : 0,
    createdAt: new Date(),
    expiresAt: new Date(),
    decidedAt: null,
  });

  const request = (_req: ApprovalRequest): Effect.Effect<ApprovalResult, ApprovalError> =>
    Effect.sync(() => {
      const id = nextId("fake-approval");
      statuses.set(id, "pending");
      return toResult(id, "pending");
    });

  // Mirrors the real `ApprovalService.requestAutoApproved` — always
  // "approved" immediately, unlike `request` above which the real service
  // only auto-approves when the org's own settings resolve to mode "none".
  // `ElevationService`'s "always"-policy branch calls this one directly.
  const requestAutoApproved = (
    _req: ApprovalRequest,
  ): Effect.Effect<ApprovalResult, ApprovalError> =>
    Effect.sync(() => {
      const id = nextId("fake-auto-approval");
      statuses.set(id, "approved");
      return toResult(id, "approved");
    });

  const status = (approvalId: string): Effect.Effect<ApprovalResult, ApprovalError> =>
    Effect.sync(() => toResult(approvalId, statuses.get(approvalId) ?? "pending"));

  const decide = (): Effect.Effect<ApprovalResult, ApprovalError> =>
    Effect.fail(new ApprovalError({ reason: "not_found" }));

  const list = (): Effect.Effect<never, ApprovalError> => Effect.die("not used in this test");

  return {
    layer: Layer.succeed(ApprovalService, {
      _tag: "ApprovalService" as const,
      request,
      decide,
      status,
      list,
      requestAutoApproved,
    }),
    setStatus: (approvalId: string, next: ApprovalResult["status"]) =>
      statuses.set(approvalId, next),
  };
}

/** In-memory `EventBus` fake — captures every published event for assertions instead of hitting Postgres. */
function makeFakeEventBus() {
  const published: DomainEvent[] = [];
  const publish = (batch: ReadonlyArray<DomainEvent>): Effect.Effect<void, EventBusError> =>
    Effect.sync(() => {
      published.push(...batch);
    });
  return { layer: Layer.succeed(EventBus, { _tag: "EventBus" as const, publish }), published };
}

async function run<A, E>(
  effect: Effect.Effect<A, E, ElevationService>,
  layers: {
    repo: Layer.Layer<ElevationRepoTag>;
    approval: Layer.Layer<ApprovalService>;
    eventBus: Layer.Layer<EventBus>;
  },
) {
  const AppLayer = ElevationService.Default.pipe(
    Layer.provide(layers.repo),
    Layer.provide(layers.approval),
    Layer.provide(layers.eventBus),
  );
  return Effect.runPromise(Effect.provide(effect, AppLayer));
}

describe("ElevationService", () => {
  test("self-owned machine: no elevation needed at all", async () => {
    const s = seed();
    const repo = makeFakeRepo(s);
    const approval = makeFakeApprovalService();
    const eventBus = makeFakeEventBus();

    const error = await run(
      Effect.gen(function* () {
        const svc = yield* ElevationService;
        return yield* Effect.flip(
          svc.request({
            personId: s.ownerPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "testing",
          }),
        );
      }),
      { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer },
    );
    expect(error).toBeInstanceOf(SelfOwnedMachineError);
    expect(eventBus.published).toEqual([]);
  });

  test("unknown machine fails with MachineNotFoundError", async () => {
    const s = seed();
    const repo = makeFakeRepo(s);
    const approval = makeFakeApprovalService();
    const eventBus = makeFakeEventBus();

    const error = await run(
      Effect.gen(function* () {
        const svc = yield* ElevationService;
        return yield* Effect.flip(
          svc.request({
            personId: s.adminPersonId,
            machineId: "does-not-exist",
            level: "file_recovery",
            reason: "x",
          }),
        );
      }),
      { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer },
    );
    expect(error).toBeInstanceOf(MachineNotFoundError);
  });

  test("a person from a different org cannot elevate onto this org's machine", async () => {
    const s = seed();
    const repo = makeFakeRepo(s);
    const approval = makeFakeApprovalService();
    const eventBus = makeFakeEventBus();

    const error = await run(
      Effect.gen(function* () {
        const svc = yield* ElevationService;
        return yield* Effect.flip(
          svc.request({
            personId: s.outsiderPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "x",
          }),
        );
      }),
      { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer },
    );
    expect(error).toBeInstanceOf(PersonNotFoundError);
  });

  test("a deactivated (offboarded) person cannot elevate", async () => {
    const s = seed();
    const repo = makeFakeRepo(s);
    const approval = makeFakeApprovalService();
    const eventBus = makeFakeEventBus();

    const error = await run(
      Effect.gen(function* () {
        const svc = yield* ElevationService;
        return yield* Effect.flip(
          svc.request({
            personId: s.deactivatedPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "x",
          }),
        );
      }),
      { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer },
    );
    expect(error).toBeInstanceOf(PersonNotFoundError);
  });

  describe("org policy: never", () => {
    test("denies immediately, no approval call needed", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "never");
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();

      const error = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* Effect.flip(
            svc.request({
              personId: s.adminPersonId,
              machineId: s.machineId,
              level: "file_recovery",
              reason: "need it",
            }),
          );
        }),
        { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer },
      );
      expect(error).toBeInstanceOf(ElevationPolicyDeniedError);
      expect(eventBus.published).toEqual([]);
      expect(repo.elevationsById.size).toBe(0);
    });
  });

  describe("org policy: always", () => {
    test("grants immediately — still logged and time-boxed, not a free-for-all", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "always");
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();

      const elevation = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.request({
            personId: s.adminPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "need it",
          });
        }),
        { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer },
      );

      expect(elevation.status).toBe("granted");
      expect(elevation.grantedAt).not.toBeNull();
      expect(elevation.expiresAt).not.toBeNull();
      expect(elevation.approvalId).not.toBeNull();
      expect(eventBus.published.map((e) => e.type)).toEqual([
        "access.elevation_requested",
        "access.elevation_granted",
      ]);
    });
  });

  describe("org policy: with_approval", () => {
    test("file_recovery may proceed at the default (single) approval mode", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "with_approval");
      // admin_access_approval_mode left unset — defaults to "single", which satisfies file_recovery's floor.
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();

      const elevation = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.request({
            personId: s.adminPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "need it",
          });
        }),
        { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer },
      );

      expect(elevation.status).toBe("requested");
      expect(elevation.grantedAt).toBeNull();
      expect(elevation.approvalId).not.toBeNull();
      expect(eventBus.published.map((e) => e.type)).toEqual(["access.elevation_requested"]);
    });

    test("shell is refused when the org's configured approval mode is only single", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "with_approval");
      repo.setSetting(ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY, "single");
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();

      const error = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* Effect.flip(
            svc.request({
              personId: s.adminPersonId,
              machineId: s.machineId,
              level: "shell",
              reason: "need shell",
            }),
          );
        }),
        { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer },
      );

      expect(error).toBeInstanceOf(ElevationPolicyDeniedError);
      // Refused before ever contacting ApprovalService — nothing was created or emitted.
      expect(eventBus.published).toEqual([]);
      expect(repo.elevationsById.size).toBe(0);
    });

    test("shell proceeds once the org's configured approval mode is dual", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "with_approval");
      repo.setSetting(ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY, "dual");
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();

      const elevation = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.request({
            personId: s.adminPersonId,
            machineId: s.machineId,
            level: "shell",
            reason: "need shell",
          });
        }),
        { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer },
      );

      expect(elevation.status).toBe("requested");
      expect(elevation.level).toBe("shell");
    });

    test("syncApproval grants once the approval is later approved", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "with_approval");
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();
      const layers = { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer };

      const requested = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.request({
            personId: s.adminPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "need it",
          });
        }),
        layers,
      );
      expect(requested.status).toBe("requested");
      const approvalId = requested.approvalId;
      if (!approvalId) throw new Error("expected approvalId to be set");
      approval.setStatus(approvalId, "approved");

      const synced = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.syncApproval(requested.id);
        }),
        layers,
      );
      expect(synced.status).toBe("granted");
      expect(synced.expiresAt).not.toBeNull();
      expect(eventBus.published.map((e) => e.type)).toEqual([
        "access.elevation_requested",
        "access.elevation_granted",
      ]);
      // The later, separately-triggered grant shares the original request's
      // correlationId (the elevation's own id) — an auditor tracing this
      // elevation by correlationId gets the whole request→approve→grant chain.
      const [requestedEvent, grantedEvent] = eventBus.published;
      expect(requestedEvent?.correlationId).toBe(requested.id);
      expect(grantedEvent?.correlationId).toBe(requested.id);
    });

    test("syncApproval denies once the approval is rejected", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "with_approval");
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();
      const layers = { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer };

      const requested = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.request({
            personId: s.adminPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "need it",
          });
        }),
        layers,
      );
      const approvalId = requested.approvalId;
      if (!approvalId) throw new Error("expected approvalId to be set");
      approval.setStatus(approvalId, "rejected");

      const synced = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.syncApproval(requested.id);
        }),
        layers,
      );
      expect(synced.status).toBe("denied");
      // No granted event — approval.denied is unit 5's event to emit, not ours.
      expect(eventBus.published.map((e) => e.type)).toEqual(["access.elevation_requested"]);
    });

    test("syncApproval no-ops while the approval is still pending", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "with_approval");
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();
      const layers = { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer };

      const requested = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.request({
            personId: s.adminPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "need it",
          });
        }),
        layers,
      );

      const synced = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.syncApproval(requested.id);
        }),
        layers,
      );
      expect(synced.status).toBe("requested");
      expect(eventBus.published.map((e) => e.type)).toEqual(["access.elevation_requested"]);
    });
  });

  describe("expireElevation", () => {
    test("flips a granted elevation past its expiresAt to expired, and emits the event", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "always");
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();
      const layers = { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer };

      const granted = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.request({
            personId: s.adminPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "need it",
          });
        }),
        layers,
      );

      // Force the clock: back-date expiresAt so expire() has something to act
      // on without this unit needing a real scheduled sweep.
      const existing = repo.elevationsById.get(granted.id);
      if (!existing) throw new Error("expected the elevation to exist in the fake repo");
      repo.elevationsById.set(granted.id, { ...existing, expiresAt: new Date(Date.now() - 1000) });

      await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.expire(granted.id);
        }),
        layers,
      );

      expect(repo.elevationsById.get(granted.id)?.status).toBe("expired");
      expect(eventBus.published.map((e) => e.type)).toEqual([
        "access.elevation_requested",
        "access.elevation_granted",
        "access.elevation_expired",
      ]);
    });

    test("refuses to expire an elevation that hasn't reached expiresAt yet", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "always");
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();
      const layers = { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer };

      const granted = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.request({
            personId: s.adminPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "need it",
          });
        }),
        layers,
      );

      const error = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* Effect.flip(svc.expire(granted.id));
        }),
        layers,
      );
      expect(error).toBeInstanceOf(ElevationStateError);
    });

    test("refuses to expire an elevation that was never granted", async () => {
      const s = seed();
      const repo = makeFakeRepo(s);
      repo.setSetting(ADMIN_ACCESS_POLICY_SETTING_KEY, "with_approval");
      const approval = makeFakeApprovalService();
      const eventBus = makeFakeEventBus();
      const layers = { repo: repo.layer, approval: approval.layer, eventBus: eventBus.layer };

      const requested = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* svc.request({
            personId: s.adminPersonId,
            machineId: s.machineId,
            level: "file_recovery",
            reason: "need it",
          });
        }),
        layers,
      );
      expect(requested.status).toBe("requested");

      const error = await run(
        Effect.gen(function* () {
          const svc = yield* ElevationService;
          return yield* Effect.flip(svc.expire(requested.id));
        }),
        layers,
      );
      expect(error).toBeInstanceOf(ElevationStateError);
    });
  });
});
