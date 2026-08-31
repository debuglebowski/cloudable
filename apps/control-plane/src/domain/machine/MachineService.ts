import { machinePackages, machines } from "@cloudable/schema";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { Data, Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { InvalidCursorError, MachineNotFoundError, PackagePinConflictError } from "./errors";
import {
  machineCreatedEvent,
  machineOwnerAssignedEvent,
  machineSettingChangedEvent,
} from "./events";
import {
  type MachinePackageRow,
  type ResolvedManifestEntry,
  findPinConflicts,
  resolveManifest,
} from "./manifest";
import { resolveOrgDefaultRegion } from "./region-policy";

export class MachineServiceError extends Data.TaggedError("MachineServiceError")<{
  reason: string;
  cause?: unknown;
}> {}

type MachineRow = typeof machines.$inferSelect;
type MachinePackageTableRow = typeof machinePackages.$inferSelect;

export interface CreateMachineInput {
  orgId: string;
  name: string;
  // Optional (and nullable, same convention as `templateId`/`actorPersonId`
  // below — `exactOptionalPropertyTypes` needs a real "not provided" value
  // callers can pass through explicitly): spec.md §5 lists region among
  // every setting that must flow org → machine through `resolveSetting()`,
  // not a caller-supplied value. Omitted/null/blank, `create` resolves the
  // org's configured default region (`region-policy.ts`) rather than
  // requiring the caller to always supply one. An explicit value is still
  // honored as-is — this is a one-time resolution at creation, not a live
  // override channel (see `region-policy.ts`'s doc comment for why region
  // differs from retention).
  region?: string | null;
  sizeSku: string;
  image: string;
  // Required, never null: CLAUDE.md invariant #3 — a machine always has
  // exactly one owner, always a person. An owner is cleared only later, by
  // offboarding an existing machine, never omitted at creation.
  ownerPersonId: string;
  templateId?: string | null;
  actorPersonId?: string | null;
}

export interface ListMachinesInput {
  orgId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface ListMachinesResult {
  items: MachineRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface MachineDetail extends MachineRow {
  manifest: ResolvedManifestEntry[];
}

export interface PackageManifestEdit {
  packageName: string;
  versionPin?: string | null | undefined;
  pinned?: boolean | undefined;
}

export interface UpdateMachinePackagesInput {
  machineId: string;
  upserts?: ReadonlyArray<PackageManifestEdit> | undefined;
  removals?: ReadonlyArray<string> | undefined;
  actorPersonId?: string | null;
}

export interface UpdateMachinePackagesResult {
  manifest: ResolvedManifestEntry[];
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface Cursor {
  createdAt: string;
  id: string;
}

const encodeCursor = (row: { createdAt: Date; id: string }): string =>
  Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id } satisfies Cursor),
    "utf8",
  ).toString("base64url");

const decodeCursor = (cursor: string): Cursor => {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<Cursor>;
  if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
    throw new Error("invalid cursor");
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
};

const toManifestRow = (row: MachinePackageTableRow): MachinePackageRow => ({
  scopeType: row.scopeType,
  scopeId: row.scopeId,
  packageName: row.packageName,
  versionPin: row.versionPin,
  pinned: row.pinned,
  source: row.source,
});

const notFound = (machineId: string) =>
  new MachineNotFoundError({
    error: { code: "not_found", message: `Machine ${machineId} not found`, requestId: ulid() },
  });

/**
 * Business logic for the machine desired-state API — spec.md §5-7. Wraps
 * `machines`/`machine_packages` DB access and `EventBus` publication behind
 * a single `Effect.Service` (one real implementation, not a swappable
 * port — same shape as `ApprovalService`). HTTP handlers
 * (`http/handlers/machines.ts`) stay thin wrappers over this.
 */
export class MachineService extends Effect.Service<MachineService>()("MachineService", {
  effect: Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;

    const manifestScopeFilter = (machine: Pick<MachineRow, "id" | "orgId" | "templateId">) => {
      const conditions = [
        and(eq(machinePackages.scopeType, "org"), eq(machinePackages.scopeId, machine.orgId)),
        and(eq(machinePackages.scopeType, "machine"), eq(machinePackages.scopeId, machine.id)),
      ];
      if (machine.templateId) {
        const templateId = machine.templateId;
        conditions.push(
          and(eq(machinePackages.scopeType, "template"), eq(machinePackages.scopeId, templateId)),
        );
      }
      return or(...conditions);
    };

    const fetchManifestRows = (machine: Pick<MachineRow, "id" | "orgId" | "templateId">) =>
      Effect.tryPromise({
        try: () => db.select().from(machinePackages).where(manifestScopeFilter(machine)),
        catch: (cause) => new MachineServiceError({ reason: "manifest_read_failed", cause }),
      });

    const fetchMachine = (machineId: string) =>
      Effect.gen(function* () {
        const rows = yield* Effect.tryPromise({
          try: () => db.select().from(machines).where(eq(machines.id, machineId)).limit(1),
          catch: (cause) => new MachineServiceError({ reason: "get_failed", cause }),
        });
        const machine = rows[0];
        if (!machine) return yield* Effect.fail(notFound(machineId));
        return machine;
      });

    const publishOrFail = (batch: Parameters<typeof eventBus.publish>[0]) =>
      eventBus
        .publish(batch)
        .pipe(
          Effect.mapError(
            (cause) => new MachineServiceError({ reason: "event_publish_failed", cause }),
          ),
        );

    const create = (input: CreateMachineInput): Effect.Effect<MachineRow, MachineServiceError> =>
      Effect.gen(function* () {
        const region =
          input.region && input.region.trim().length > 0
            ? input.region
            : (yield* resolveOrgDefaultRegion(db, input.orgId)).value;

        const rows = yield* Effect.tryPromise({
          try: () =>
            db
              .insert(machines)
              .values({
                orgId: input.orgId,
                templateId: input.templateId ?? null,
                ownerPersonId: input.ownerPersonId,
                name: input.name,
                region,
                sizeSku: input.sizeSku,
                image: input.image,
              })
              .returning(),
          catch: (cause) => new MachineServiceError({ reason: "create_failed", cause }),
        });
        const machine = rows[0];
        if (!machine)
          return yield* Effect.fail(new MachineServiceError({ reason: "create_failed" }));

        const correlationId = ulid();
        const actorType = input.actorPersonId ? "person" : "system";
        const actorId = input.actorPersonId ?? "system";
        yield* publishOrFail([
          machineCreatedEvent({
            machineId: machine.id,
            orgId: machine.orgId,
            correlationId,
            actorType,
            actorId,
            name: machine.name,
            region: machine.region,
            size: machine.sizeSku,
            image: machine.image,
          }),
          machineOwnerAssignedEvent({
            machineId: machine.id,
            orgId: machine.orgId,
            correlationId,
            actorType,
            actorId,
            personId: input.ownerPersonId,
            previousPersonId: null,
          }),
        ]);

        return machine;
      });

    const list = (
      input: ListMachinesInput,
    ): Effect.Effect<ListMachinesResult, MachineServiceError | InvalidCursorError> =>
      Effect.gen(function* () {
        const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
        let cursor: Cursor | null = null;
        if (input.cursor) {
          try {
            cursor = decodeCursor(input.cursor);
          } catch {
            return yield* Effect.fail(
              new InvalidCursorError({
                error: {
                  code: "invalid_cursor",
                  message: "The cursor query parameter is malformed.",
                  requestId: ulid(),
                },
              }),
            );
          }
        }

        const rows = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(machines)
              .where(
                cursor
                  ? and(
                      eq(machines.orgId, input.orgId),
                      or(
                        gt(machines.createdAt, new Date(cursor.createdAt)),
                        and(
                          eq(machines.createdAt, new Date(cursor.createdAt)),
                          gt(machines.id, cursor.id),
                        ),
                      ),
                    )
                  : eq(machines.orgId, input.orgId),
              )
              .orderBy(asc(machines.createdAt), asc(machines.id))
              .limit(limit + 1),
          catch: (cause) => new MachineServiceError({ reason: "list_failed", cause }),
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items[items.length - 1];

        return { items, hasMore, nextCursor: hasMore && last ? encodeCursor(last) : null };
      });

    const getById = (
      machineId: string,
    ): Effect.Effect<MachineDetail, MachineServiceError | MachineNotFoundError> =>
      Effect.gen(function* () {
        const machine = yield* fetchMachine(machineId);
        const rows = yield* fetchManifestRows(machine);
        const manifest = resolveManifest(rows.map(toManifestRow), {
          orgId: machine.orgId,
          templateId: machine.templateId,
          machineId: machine.id,
        });
        return { ...machine, manifest };
      });

    const updatePackages = (
      input: UpdateMachinePackagesInput,
    ): Effect.Effect<
      UpdateMachinePackagesResult,
      MachineServiceError | MachineNotFoundError | PackagePinConflictError
    > =>
      Effect.gen(function* () {
        const machine = yield* fetchMachine(input.machineId);
        const upserts = input.upserts ?? [];
        const removals = input.removals ?? [];
        const editedPackageNames = [
          ...new Set([...upserts.map((u) => u.packageName), ...removals]),
        ];

        const existingRows = (yield* fetchManifestRows(machine)).map(toManifestRow);

        const conflicts = findPinConflicts(existingRows, "machine", editedPackageNames);
        if (conflicts.length > 0) {
          return yield* Effect.fail(
            new PackagePinConflictError({
              error: {
                code: "pinned_entry_conflict",
                message: `${conflicts.length} package(s) are pinned above the machine scope and cannot be overridden below.`,
                requestId: ulid(),
                details: { conflicts },
              },
            }),
          );
        }

        const chain = {
          orgId: machine.orgId,
          templateId: machine.templateId,
          machineId: machine.id,
        };
        const previousByName = new Map(
          resolveManifest(existingRows, chain).map((entry) => [entry.packageName, entry]),
        );

        yield* Effect.tryPromise({
          try: async () => {
            for (const upsert of upserts) {
              await db
                .insert(machinePackages)
                .values({
                  scopeType: "machine",
                  scopeId: machine.id,
                  packageName: upsert.packageName,
                  versionPin: upsert.versionPin ?? null,
                  pinned: upsert.pinned ?? false,
                  source: "machine",
                })
                .onConflictDoUpdate({
                  target: [
                    machinePackages.scopeType,
                    machinePackages.scopeId,
                    machinePackages.packageName,
                  ],
                  set: {
                    versionPin: upsert.versionPin ?? null,
                    pinned: upsert.pinned ?? false,
                    source: "machine",
                    updatedAt: new Date(),
                  },
                });
            }
            for (const packageName of removals) {
              await db
                .delete(machinePackages)
                .where(
                  and(
                    eq(machinePackages.scopeType, "machine"),
                    eq(machinePackages.scopeId, machine.id),
                    eq(machinePackages.packageName, packageName),
                  ),
                );
            }
          },
          catch: (cause) => new MachineServiceError({ reason: "manifest_write_failed", cause }),
        });

        const refreshedRows = (yield* fetchManifestRows(machine)).map(toManifestRow);
        const newManifest = resolveManifest(refreshedRows, chain);
        const newByName = new Map(newManifest.map((entry) => [entry.packageName, entry]));

        const correlationId = ulid();
        const actorType = input.actorPersonId ? "person" : "system";
        const actorId = input.actorPersonId ?? "system";
        const settingEvents = editedPackageNames.map((packageName) => {
          const previous = previousByName.get(packageName);
          const current = newByName.get(packageName);
          return machineSettingChangedEvent({
            machineId: machine.id,
            orgId: machine.orgId,
            correlationId,
            actorType,
            actorId,
            key: packageName,
            previous: previous
              ? { versionPin: previous.versionPin, pinned: previous.pinned }
              : null,
            current: current ? { versionPin: current.versionPin, pinned: current.pinned } : null,
            overridesLevel: previous?.source ?? "none",
          });
        });

        if (settingEvents.length > 0) {
          yield* publishOrFail(settingEvents);
        }

        return { manifest: newManifest };
      });

    return { create, list, getById, updatePackages } as const;
  }),
  dependencies: [EventBus.Default],
}) {}
