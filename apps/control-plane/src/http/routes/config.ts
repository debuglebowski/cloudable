import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import {
  ConfirmationRequiredError,
  InvalidScopeError,
  MachineNotFoundError,
  PinnedSettingError,
  SettingWriteError,
} from "../../domain/config/errors";
import { CurrentUserAuthentication } from "../middleware/auth";

// Wire schemas for `/api/v1/config/...`. These mirror
// `packages/contracts/src/domains/config.ts`'s plain interfaces (the CLI's
// dependency-free copy) but are the actual runtime-validated shapes the
// HttpApi layer decodes/encodes against — see the comment at the top of
// that contracts file for why the two aren't the same objects.

export const SettingScopeType = Schema.Literal("org", "machine");

export const SettingChangeResult = Schema.Struct({
  scopeType: SettingScopeType,
  scopeId: Schema.String,
  key: Schema.String,
  previous: Schema.Unknown,
  current: Schema.Unknown,
});

// `orgId`/`actor` are gone from the wire — the server derives both from the
// caller's session (`CurrentUserTag`): every config change is now
// necessarily a real person acting through the console, not a
// client-supplied identity (see `http/handlers/config.ts`).
export const PatchSettingPayload = Schema.Struct({
  scopeType: SettingScopeType,
  scopeId: Schema.String,
  key: Schema.String,
  value: Schema.Unknown,
  pinned: Schema.optional(Schema.Boolean),
});

export const PatchSettingResponse = Schema.Struct({
  setting: SettingChangeResult,
});

export const ReconcileTriggerParams = Schema.Struct({
  id: Schema.String,
});

// `confirm` is deliberately optional, not required: both "absent" and
// "false" must be rejected by the same confirmation-gate error (see
// trigger-reconcile.ts), rather than "absent" failing schema validation and
// "false" failing a domain check — one rule, one code path. `orgId` is
// gone from the wire — derived from `CurrentUserTag.orgId` and checked
// against the target machine's own org, the tenant-isolation boundary this
// endpoint needs (see `../middleware/auth.ts`).
export const ReconcileTriggerPayload = Schema.Struct({
  confirm: Schema.optional(Schema.Boolean),
});

export const ReconcileTriggerResponse = Schema.Struct({
  machineId: Schema.String,
  desiredStateVersion: Schema.Number,
});

export const ImportConfigEntry = Schema.Struct({
  scopeType: SettingScopeType,
  scopeId: Schema.String,
  key: Schema.String,
  value: Schema.Unknown,
  pinned: Schema.optional(Schema.Boolean),
});

export const ImportConfigPayload = Schema.Struct({
  correlationId: Schema.optional(Schema.String),
  entries: Schema.Array(ImportConfigEntry),
});

export const ImportConfigResponse = Schema.Struct({
  applied: Schema.Array(SettingChangeResult),
});

export const ConfigGroup = HttpApiGroup.make("config")
  .add(
    HttpApiEndpoint.patch("patchSetting", "/api/v1/config/settings")
      .setPayload(PatchSettingPayload)
      .addSuccess(PatchSettingResponse)
      .addError(InvalidScopeError, { status: 400 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(PinnedSettingError, { status: 409 })
      .addError(SettingWriteError, { status: 500 }),
  )
  .add(
    // The confirmation-gated reconcile trigger. This is the ONLY endpoint in
    // this group allowed to mutate a machine — it never writes
    // settingValues, it only bumps machines.desiredStateVersion.
    HttpApiEndpoint.post("triggerReconcile", "/api/v1/config/machines/:id/reconcile")
      .setPath(ReconcileTriggerParams)
      .setPayload(ReconcileTriggerPayload)
      .addSuccess(ReconcileTriggerResponse)
      .addError(ConfirmationRequiredError, { status: 400 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(SettingWriteError, { status: 500 }),
  )
  .add(
    // The GitOps path: a bulk desired-state document applied entry-by-entry
    // through the exact same `applySettingChange` function `patchSetting`
    // uses — same path whether the change came from the UI or a Git commit.
    // Also purely inert — never touches a machine.
    HttpApiEndpoint.post("importConfig", "/api/v1/config/import")
      .setPayload(ImportConfigPayload)
      .addSuccess(ImportConfigResponse)
      .addError(InvalidScopeError, { status: 400 })
      .addError(MachineNotFoundError, { status: 404 })
      .addError(PinnedSettingError, { status: 409 })
      .addError(SettingWriteError, { status: 500 }),
  )
  .middleware(CurrentUserAuthentication);
