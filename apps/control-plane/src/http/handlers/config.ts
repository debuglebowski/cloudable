import { HttpApiBuilder } from "@effect/platform";
import { Effect, type Schema } from "effect";
import { ulid } from "ulid";
import { NotPermittedError, requireAdminUser } from "../../domain/authz";
import { applySettingChange } from "../../domain/config/apply-setting-change";
import {
  ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY,
  ADMIN_ACCESS_POLICY_SETTING_KEY,
} from "../../domain/elevation/policy";
import { Api } from "../api";
import { type CurrentUser, CurrentUserTag } from "../middleware/auth";
import type { ImportConfigPayload, PatchSettingPayload } from "../routes/config";

// Handler bodies are exported as plain functions, independent of
// `HttpApiBuilder.group`'s wiring, so tests can call `handlePatchSetting`
// and `handleImportConfig` directly and assert they both go through
// `applySettingChange` — see `../../domain/config/config.test.ts`. Identity
// (`orgId`/`personId`) is threaded in as a separate `currentUser` argument
// rather than read from the payload — every config change is now
// necessarily a real person acting through the console (`actorType` is
// always `"person"`; there is no HTTP-triggered `"system"` actor anymore).

/**
 * Every setting is configuration, so only an admin writes one, at either scope. Two kinds of key
 * not even an admin writes here:
 *
 * - `admin_access_policy` is pinned at deploy time (`ADMIN_ACCESS_POLICY`), so it cannot be
 *   loosened from the console by anyone.
 * - Approval modes change only with an approver's sign-off, through
 *   `POST /api/v1/organisation/approval-modes` (see `domain/organisation/approval-settings-change.ts`).
 */
const authorizeSettingWrite = (currentUser: CurrentUser, key: string) =>
  Effect.gen(function* () {
    yield* requireAdminUser(currentUser, "Only an admin can change settings.");
    if (key === ADMIN_ACCESS_POLICY_SETTING_KEY) {
      return yield* Effect.fail(
        new NotPermittedError({
          reason:
            "Admin access to someone else's machine is set when Cloudable is deployed (ADMIN_ACCESS_POLICY) and cannot be changed here.",
        }),
      );
    }
    if (key.startsWith("approval_mode:") || key === ADMIN_ACCESS_APPROVAL_MODE_SETTING_KEY) {
      return yield* Effect.fail(
        new NotPermittedError({
          reason:
            "Approval settings change only with an approver's sign-off. Ask for the change on the Organisation page.",
        }),
      );
    }
  });

export const handlePatchSetting = (
  payload: Schema.Schema.Type<typeof PatchSettingPayload>,
  currentUser: CurrentUser,
) =>
  Effect.zipRight(
    authorizeSettingWrite(currentUser, payload.key),
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
    ),
  );

export const handleImportConfig = (
  payload: Schema.Schema.Type<typeof ImportConfigPayload>,
  currentUser: CurrentUser,
) =>
  Effect.gen(function* () {
    // The whole import is one operation — every event it produces shares a
    // correlationId, same as a PATCH shares one for its single change.
    const correlationId = payload.correlationId ?? ulid();
    // Every entry is checked before any is applied, so a refused key fails the whole import
    // rather than leaving half of it written.
    for (const entry of payload.entries) {
      yield* authorizeSettingWrite(currentUser, entry.key);
    }

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
    .handle("importConfig", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        return yield* handleImportConfig(payload, currentUser);
      }),
    ),
);
