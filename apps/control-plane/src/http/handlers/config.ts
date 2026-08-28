import { HttpApiBuilder } from "@effect/platform";
import { Effect, type Schema } from "effect";
import { ulid } from "ulid";
import { applySettingChange } from "../../domain/config/apply-setting-change";
import { triggerReconcile } from "../../domain/config/trigger-reconcile";
import { Api } from "../api";
import type {
  ImportConfigPayload,
  PatchSettingPayload,
  ReconcileTriggerParams,
  ReconcileTriggerPayload,
} from "../routes/config";

// Handler bodies are exported as plain functions, independent of
// `HttpApiBuilder.group`'s wiring, so tests can call `handlePatchSetting`
// and `handleImportConfig` directly and assert they both go through
// `applySettingChange` — see `../../domain/config/config.test.ts`.

export const handlePatchSetting = (payload: Schema.Schema.Type<typeof PatchSettingPayload>) =>
  Effect.map(
    applySettingChange({
      orgId: payload.orgId,
      scopeType: payload.scopeType,
      scopeId: payload.scopeId,
      key: payload.key,
      value: payload.value,
      pinned: payload.pinned,
      actorType: payload.actor.type,
      actorId: payload.actor.id,
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
) => triggerReconcile({ orgId: payload.orgId, machineId: path.id, confirm: payload.confirm });

export const handleImportConfig = (payload: Schema.Schema.Type<typeof ImportConfigPayload>) =>
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
            orgId: payload.orgId,
            scopeType: entry.scopeType,
            scopeId: entry.scopeId,
            key: entry.key,
            value: entry.value,
            pinned: entry.pinned,
            actorType: payload.actor.type,
            actorId: payload.actor.id,
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
    .handle("patchSetting", ({ payload }) => handlePatchSetting(payload))
    .handle("triggerReconcile", ({ path, payload }) => handleTriggerReconcile(path, payload))
    .handle("importConfig", ({ payload }) => handleImportConfig(payload)),
);
