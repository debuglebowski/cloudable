import type { DomainEvent, OrgEvent } from "@cloudable/events";
import { type SettingRow, machines, resolveSetting, settingValues } from "@cloudable/schema";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { EventBus } from "../../services/EventBus";
import { TunnelServer } from "../../tunnel/server";
import { machineSettingChangedEvent } from "../machine/events";
import { ACCESS_METHODS_ENABLED_KEY, webTerminalEnabledOf } from "../machine/settings";
import {
  InvalidScopeError,
  MachineNotFoundError,
  PinnedSettingError,
  SettingWriteError,
} from "./errors";
import { isPackageManifestKey } from "./validate-pinning";

export interface ApplySettingChangeInput {
  orgId: string;
  scopeType: "org" | "machine";
  scopeId: string;
  key: string;
  value: unknown;
  /** Org-scope only. Ignored (existing flag preserved) on a machine-scope write. */
  pinned?: boolean | undefined;
  actorType: "person" | "system";
  actorId: string;
  correlationId: string;
  /** Defaults to now. Exposed for tests. */
  occurredAt?: Date;
}

export interface ApplySettingChangeResult {
  previous: unknown;
  current: unknown;
  event: DomainEvent;
}

export type ApplySettingChangeError =
  | InvalidScopeError
  | MachineNotFoundError
  | PinnedSettingError
  | SettingWriteError;

/**
 * The single code path that writes a `settingValues` row and emits the
 * corresponding `*.setting_changed` event. Both the UI-facing PATCH
 * endpoint (`handlePatchSetting`) and the Git-sourced bulk import endpoint
 * (`handleImportConfig`) call this exact function, entry for entry — the
 * same path whether the change came from the UI or a Git commit.
 *
 * Inert with respect to a machine's *desired state*: it never reads or writes `machines.desiredStateVersion`
 * and never triggers reconcile — the agent picks up the new resolved value
 * on its own next poll. See `trigger-reconcile.ts` for the only operation
 * allowed to mutate a machine's desired-state version, which is
 * confirmation-gated.
 *
 * One deliberate exception to "only ever touches `setting_values` and the
 * append-only `events` table": a write to `machine.accessMethodsEnabled`
 * that disables web terminal also ends every affected machine's open
 * `sessions` rows via `TunnelServer.terminateSessionsForMachine` — disabling
 * terminates live sessions, not merely refuses new
 * ones. This is a *live session*, not a desired-state mutation, so it
 * doesn't touch `machines.desiredStateVersion` either and doesn't violate
 * the point above — but it is real DB/event activity beyond
 * `setting_values`/`events`, and runs after this function's own
 * `*.setting_changed` event is durably published (see below) so that a
 * termination failure never hides the fact that the setting itself did
 * change.
 */
export const applySettingChange = (
  input: ApplySettingChangeInput,
): Effect.Effect<ApplySettingChangeResult, ApplySettingChangeError, Db | EventBus | TunnelServer> =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;

    if (input.scopeType === "org" && input.scopeId !== input.orgId) {
      return yield* Effect.fail(
        new InvalidScopeError({ message: "an org-scope edit's scopeId must equal orgId" }),
      );
    }

    // Machine-scope: resolve the machine, verify tenancy, and (for the
    // package manifest key only — see validate-pinning.ts) check pinning
    // and compute which level this write overrides.
    let machine: typeof machines.$inferSelect | undefined;
    let overridesLevel: "org" | "template" | "machine" = "org";

    if (input.scopeType === "machine") {
      const machineRows = yield* Effect.tryPromise({
        try: () => db.select().from(machines).where(eq(machines.id, input.scopeId)).limit(1),
        catch: (cause) =>
          new SettingWriteError({ message: `looking up machine: ${String(cause)}` }),
      });
      machine = machineRows[0];
      if (!machine || machine.orgId !== input.orgId) {
        return yield* Effect.fail(new MachineNotFoundError({ machineId: input.scopeId }));
      }

      // Scoped to exactly the org/template/machine ids in this machine's own
      // chain — not every row for this key across every org. `scopeId` is a
      // globally-unique uuid so the unscoped query was correct, but it would
      // pull every tenant's rows for a common key (e.g. "packages") into
      // memory on every write.
      const chainScopeIds = [
        input.orgId,
        input.scopeId,
        ...(machine.templateId ? [machine.templateId] : []),
      ];
      const keyRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(settingValues)
            .where(
              and(eq(settingValues.key, input.key), inArray(settingValues.scopeId, chainScopeIds)),
            ),
        catch: (cause) =>
          new SettingWriteError({ message: `reading setting chain: ${String(cause)}` }),
      });

      if (isPackageManifestKey(input.key)) {
        const parentScopes: ReadonlyArray<{ scopeType: "org" | "template"; scopeId: string }> = [
          { scopeType: "org", scopeId: input.orgId },
          ...(machine.templateId
            ? [{ scopeType: "template" as const, scopeId: machine.templateId }]
            : []),
        ];
        const pinnedParent = keyRows.find(
          (row) =>
            row.pinned &&
            parentScopes.some((p) => p.scopeType === row.scopeType && p.scopeId === row.scopeId),
        );
        if (pinnedParent) {
          return yield* Effect.fail(
            new PinnedSettingError({
              key: input.key,
              pinnedAtScopeType: pinnedParent.scopeType,
              pinnedAtScopeId: pinnedParent.scopeId,
            }),
          );
        }
      }

      // What would this key resolve to without this machine's own row? That
      // is the level this write now overrides.
      const rowsExcludingThisMachine = keyRows.filter(
        (r) => !(r.scopeType === "machine" && r.scopeId === input.scopeId),
      ) as ReadonlyArray<SettingRow>;
      const resolved = resolveSetting(input.key, rowsExcludingThisMachine, {
        orgId: input.orgId,
        templateId: machine.templateId,
        machineId: input.scopeId,
      });
      overridesLevel = resolved?.source ?? "org";
    }

    // --- upsert the raw declared value (find-then-write; setting_values has
    // no unique constraint to `onConflictDoUpdate` against) ---
    const existingRows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(settingValues)
          .where(
            and(
              eq(settingValues.scopeType, input.scopeType),
              eq(settingValues.scopeId, input.scopeId),
              eq(settingValues.key, input.key),
            ),
          )
          .limit(1),
      catch: (cause) =>
        new SettingWriteError({ message: `reading setting value: ${String(cause)}` }),
    });
    const existing = existingRows[0];
    // `null`, not `undefined` — the payload is stored as JSONB, and
    // `JSON.stringify` silently drops `undefined` object keys, which would
    // make "no previous value" indistinguishable from "key never set" on
    // the event row. `null` round-trips explicitly.
    const previous: unknown = existing ? existing.value : null;

    // `pinned` is an org-scope-only concept: the
    // organisation marks an entry pinned so nothing below it can override.
    // A machine-scope write must never be able to set or clear it — that
    // would let the very override this flag exists to block also toggle it.
    const nextPinned =
      input.scopeType === "org"
        ? (input.pinned ?? existing?.pinned ?? false)
        : (existing?.pinned ?? false);

    yield* Effect.tryPromise({
      try: async () => {
        if (existing) {
          await db
            .update(settingValues)
            .set({
              value: input.value,
              pinned: nextPinned,
              updatedAt: new Date(),
            })
            .where(eq(settingValues.id, existing.id));
        } else {
          await db.insert(settingValues).values({
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            key: input.key,
            value: input.value,
            source: input.scopeType,
            pinned: nextPinned,
          });
        }
      },
      catch: (cause) =>
        new SettingWriteError({ message: `writing setting value: ${String(cause)}` }),
    });

    // --- build + publish the resulting event ---
    const occurredAt = input.occurredAt ?? new Date();
    let event: DomainEvent;
    if (input.scopeType === "machine") {
      // Shared with `MachineService.updatePackages` (the machine
      // package-manifest editor's own real write path — see
      // docs/inheritance.md for why package-manifest entries live in their
      // own `machinePackages` table rather than as `settingValues` rows)
      // so both places that ever emit `machine.setting_changed` build it
      // from the exact same shape and cannot drift apart.
      //
      // `machineSettingChangedEvent` sets `id`/`recordedAt` to placeholders
      // (real values are stamped by `EventBus.publish`'s `toEventRows` right
      // before insert — see that function's own doc comment), so they're
      // overridden here too to keep `ApplySettingChangeResult.event` — the
      // value handed back to this function's own caller, before it ever
      // reaches `publish` — populated the same way the org-scope branch
      // below populates it.
      event = {
        ...machineSettingChangedEvent({
          machineId: input.scopeId,
          orgId: input.orgId,
          correlationId: input.correlationId,
          actorType: input.actorType,
          actorId: input.actorId,
          key: input.key,
          previous,
          current: input.value,
          overridesLevel,
          occurredAt,
        }),
        id: ulid(),
        recordedAt: occurredAt,
      };
    } else {
      event = {
        id: ulid(),
        occurredAt,
        recordedAt: occurredAt,
        orgId: input.orgId,
        actorType: input.actorType,
        actorId: input.actorId,
        machineId: null,
        correlationId: input.correlationId,
        schemaVersion: 1,
        type: "org.setting_changed",
        payload: {
          key: input.key,
          previous,
          current: input.value,
          // v1 has no template UI, so an org-scope edit through this
          // endpoint always changes the org-wide default. "machine" is
          // reserved for a future path where an org admin pushes a value
          // that targets machine-level defaults directly.
          level: "org",
        },
      } satisfies OrgEvent;
    }

    yield* eventBus
      .publish([event])
      .pipe(
        Effect.mapError(
          (cause) => new SettingWriteError({ message: `publishing event: ${cause.reason}` }),
        ),
      );

    // --- Disabling terminates live sessions, not merely
    // refuses new ones. Only a webTerminal:true → false transition matters
    // here — enabling, or a no-op re-save of an already-disabled value,
    // never needs to end anything. `terminateSessionsForMachine` itself is
    // idempotent (ends only currently-open sessions), so an imprecise
    // "previous" read (see below) can at worst cause a harmless extra call,
    // never a missed one. Runs after the `*.setting_changed` event above is
    // durably published, not before: if this step fails, the setting
    // change itself is still fully recorded rather than silently lost
    // behind the resulting error.
    if (input.key === ACCESS_METHODS_ENABLED_KEY) {
      const wasEnabled = webTerminalEnabledOf(previous);
      const nowEnabled = webTerminalEnabledOf(input.value);
      if (wasEnabled && !nowEnabled) {
        const tunnelServer = yield* TunnelServer;
        const terminate = (targetMachineId: string) =>
          tunnelServer
            .terminateSessionsForMachine({
              orgId: input.orgId,
              machineId: targetMachineId,
              reason: "access.web_terminal_disabled",
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SettingWriteError({ message: `terminating sessions: ${cause.reason}` }),
              ),
            );

        if (input.scopeType === "machine") {
          yield* terminate(input.scopeId);
        } else {
          // Org-scope edit: every machine in the org WITHOUT its own
          // machine-level override for this key inherits the new org
          // default (the template layer is inert in v1 — see
          // docs/inheritance.md — so for an unoverridden machine the
          // effective value is exactly the org's own value). A machine
          // that has its own override is unaffected by this write: its own
          // row still wins resolution regardless of what the org default
          // just changed to.
          const orgMachines = yield* Effect.tryPromise({
            try: () =>
              db.select({ id: machines.id }).from(machines).where(eq(machines.orgId, input.orgId)),
            catch: (cause) =>
              new SettingWriteError({ message: `listing org machines: ${String(cause)}` }),
          });

          if (orgMachines.length > 0) {
            const overrideRows = yield* Effect.tryPromise({
              try: () =>
                db
                  .select({ scopeId: settingValues.scopeId })
                  .from(settingValues)
                  .where(
                    and(
                      eq(settingValues.scopeType, "machine"),
                      eq(settingValues.key, input.key),
                      inArray(
                        settingValues.scopeId,
                        orgMachines.map((m) => m.id),
                      ),
                    ),
                  ),
              catch: (cause) =>
                new SettingWriteError({ message: `listing machine overrides: ${String(cause)}` }),
            });
            const overridden = new Set(overrideRows.map((r) => r.scopeId));
            const affected = orgMachines.filter((m) => !overridden.has(m.id));

            yield* Effect.forEach(affected, (m) => terminate(m.id), { concurrency: 5 });
          }
        }
      }
    }

    return { previous, current: input.value, event };
  });
