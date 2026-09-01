import { HttpApiBuilder } from "@effect/platform";
import { Effect, type Schema } from "effect";
import { ulid } from "ulid";
import { applySettingChange } from "../../domain/config/apply-setting-change";
import { triggerReconcile } from "../../domain/config/trigger-reconcile";
import { Api } from "../api";
import { type CurrentUser, CurrentUserTag } from "../middleware/auth";
import type {
  ImportConfigPayload,
  PatchSettingPayload,
  ReconcileTriggerParams,
  ReconcileTriggerPayload,
} from "../routes/config";

// Handler bodies are exported as plain functions, independent of
// `HttpApiBuilder.group`'s wiring, so tests can call `handlePatchSetting`
// and `handleImportConfig` directly and assert they both go through
// `applySettingChange` — see `../../domain/config/config.test.ts`. Identity
// (`orgId`/`personId`) is threaded in as a separate `currentUser` argument
// rather than read from the payload — every config change is now
// necessarily a real person acting through the console (`actorType` is
// always `"person"`; there is no HTTP-triggered `"system"` actor anymore).

export const handlePatchSetting = (
  payload: Schema.Schema.Type<typeof PatchSettingPayload>,
  currentUser: CurrentUser,
) =>
  Effect.map(
    applySettingChange({
      orgId: currentUser.orgId,
      scopeType: payload.scopeType,
      scopeId: payload.scopeId,
      key: payload.key,
      value: payload.value,
      pinned: payload.pinned,
      actorType: "person",
      actorId: currentUser.personId,
      // One PATCH is one logical operation — one correlationId.
      correlationId: ulid(),
    }),
    (result) => ({
      setting: {
        scopeType: payload.scopeType,
        scopeId: payload.scopeId,
        key: payload.key,
        previous: result.previous,
        current: result.current,
      },
    }),
  );

export const handleTriggerReconcile = (
  path: Schema.Schema.Type<typeof ReconcileTriggerParams>,
  payload: Schema.Schema.Type<typeof ReconcileTriggerPayload>,
  currentUser: CurrentUser,
) => triggerReconcile({ orgId: currentUser.orgId, machineId: path.id, confirm: payload.confirm });

export const handleImportConfig = (
  payload: Schema.Schema.Type<typeof ImportConfigPayload>,
  currentUser: CurrentUser,
) =>
  Effect.gen(function* () {
    // The whole import is one operation — every event it produces shares a
    // correlationId (docs/spec.md §24), same as a PATCH shares one for its
    // single change.
    const correlationId = payload.correlationId ?? ulid();

    const applied = yield* Effect.forEach(
      payload.entries,
      (entry) =>
        Effect.map(
          applySettingChange({
            orgId: currentUser.orgId,
            scopeType: entry.scopeType,
            scopeId: entry.scopeId,
            key: entry.key,
            value: entry.value,
            pinned: entry.pinned,
            actorType: "person",
            actorId: currentUser.personId,
            correlationId,
          }),
          (result) => ({
            scopeType: entry.scopeType,
            scopeId: entry.scopeId,
            key: entry.key,
            previous: result.previous,
            current: result.current,
          }),
        ),
      // Sequential: entries may target the same key/scope (later wins), and
      // event ordering within one correlationId should match request order.
      { concurrency: 1 },
    );

    return { applied };
  });

export const ConfigLive = HttpApiBuilder.group(Api, "config", (handlers) =>
  handlers
    .handle("patchSetting", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* handlePatchSetting(payload, currentUser);
      }),
    )
    .handle("triggerReconcile", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* handleTriggerReconcile(path, payload, currentUser);
      }),
    )
    .handle("importConfig", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* handleImportConfig(payload, currentUser);
      }),
    ),
);
