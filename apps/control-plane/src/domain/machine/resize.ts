// ---------------------------------------------------------------------------
// Changing a machine's size (CLAUDE.md invariant 10: a machine changes only through a
// recorded action a person asked for).
//
// The owner or an admin asks. A `machine_resize` approval decides (mode on the
// Organisation page, default one approver): a bigger size costs money every hour, so it is
// a decision, not a click. Once granted, the provider deallocates the VM, sets the new
// size and starts it again. Disks, identity and network stay. The outcome is recorded as
// `machine.resized` or `machine.resize_failed`.
//
// The resize itself takes minutes, so it runs in the background after the approval; the
// person who approved does not wait on it.
// ---------------------------------------------------------------------------
import type { MachineEvent } from "@cloudable/events";
import { machines, profiles } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { ulid } from "ulid";
import { Db } from "../../db/layer";
import { type ApprovalResult, ApprovalService } from "../../services/ApprovalService";
import { getCatalogEntry } from "../../services/CloudCatalogService";
import { EventBus } from "../../services/EventBus";
import { ProvisioningServiceTag } from "../../services/ProvisioningService";
import { UBUNTU_IMAGES } from "../../services/ProvisioningService.azure";
import { resolveCreationFields } from "../profile/creation-fields";

export class ResizeRefusedError extends Schema.TaggedError<ResizeRefusedError>()(
  "ResizeRefusedError",
  {
    code: Schema.Literal(
      "machine_not_found",
      "machine_archived",
      "same_size",
      "size_fixed_by_profile",
      "unknown_size",
      "incompatible_size",
      "provider_cannot_resize",
      "reason_required",
    ),
    message: Schema.String,
  },
) {}

const refuse = (code: ResizeRefusedError["code"], message: string) =>
  Effect.fail(new ResizeRefusedError({ code, message }));

const Payload = Schema.Struct({ fromSize: Schema.String, toSize: Schema.String });
const decodePayload = Schema.decodeUnknownOption(Payload);

const dbTry = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new Error(`${message}: ${String(cause)}`) });

/**
 * Asks for a new size. Checked before anyone is asked, so an approver never approves a
 * size the machine cannot take. Applies at once when the org's `machine_resize` mode is
 * `none`.
 */
export const requestMachineResize = (input: {
  machineId: string;
  orgId: string;
  personId: string;
  sizeSku: string;
  reason: string;
}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* dbTry("reading machine", () =>
      db.select().from(machines).where(eq(machines.id, input.machineId)).limit(1),
    ).pipe(Effect.orDie);
    const machine = rows[0];
    if (!machine || machine.orgId !== input.orgId) {
      return yield* refuse("machine_not_found", "no such machine in this org");
    }
    if (machine.state === "archived_restorable" || machine.state === "archived_expired") {
      return yield* refuse("machine_archived", "an archived machine cannot be resized");
    }
    const sizeSku = input.sizeSku.trim();
    if (sizeSku === machine.sizeSku) {
      return yield* refuse("same_size", `the machine is already ${sizeSku}`);
    }
    if (!input.reason.trim()) {
      return yield* refuse("reason_required", "say why, for the approver");
    }
    if (machine.provider === "docker") {
      return yield* refuse(
        "provider_cannot_resize",
        "a local Docker machine has no size to change",
      );
    }
    if (machine.profileId) {
      const profileId = machine.profileId;
      const [profile] = yield* dbTry("reading profile", () =>
        db.select().from(profiles).where(eq(profiles.id, profileId)).limit(1),
      ).pipe(Effect.orDie);
      const baseId = profile?.baseProfileId;
      const [base] = baseId
        ? yield* dbTry("reading base profile", () =>
            db.select().from(profiles).where(eq(profiles.id, baseId)).limit(1),
          ).pipe(Effect.orDie)
        : [];
      // Only a locked size binds the machine, whether the profile or its base locks it. An
      // unlocked one was a starting value.
      const size = profile ? resolveCreationFields(profile, base).sizeSku : null;
      if (size?.locked && size.value !== null && size.value !== sizeSku) {
        const lockedBy = size.fromProfileId === base?.id ? base : profile;
        return yield* refuse(
          "size_fixed_by_profile",
          `profile "${lockedBy?.name}" locks the size at ${size.value}`,
        );
      }
    }
    if (machine.provider === "azure") {
      const entry = yield* getCatalogEntry("azure", "sku", sizeSku).pipe(Effect.orDie);
      if (!entry) return yield* refuse("unknown_size", `size "${sizeSku}" is not in the catalog`);
      const image = UBUNTU_IMAGES[machine.image];
      if (image && entry.architecture && entry.architecture !== image.architecture) {
        return yield* refuse(
          "incompatible_size",
          `size "${sizeSku}" (${entry.architecture}) cannot run image "${machine.image}" (${image.architecture})`,
        );
      }
    }

    const approvalService = yield* ApprovalService;
    const approval = yield* approvalService
      .request({
        orgId: input.orgId,
        actionType: "machine_resize",
        requestedByPersonId: input.personId,
        targetMachineId: machine.id,
        reason: input.reason,
        payload: { fromSize: machine.sizeSku, toSize: sizeSku },
      })
      .pipe(Effect.orDie);
    if (approval.status === "approved") yield* applyApprovedResize(approval);
    return { approvalId: approval.id, status: approval.status };
  });

/**
 * Carries out a granted resize, in the background: deallocate, resize and start take
 * minutes. Called once per approval by `domain/approvals/carry-out.ts`, or straight away
 * when the mode is `none`. Never fails its caller; the outcome is recorded either way.
 */
export const applyApprovedResize = (
  approval: ApprovalResult,
): Effect.Effect<void, never, Db | EventBus | ProvisioningServiceTag> =>
  Effect.gen(function* () {
    const decoded = decodePayload(approval.payload);
    if (decoded._tag === "None" || approval.targetMachineId === null) {
      return yield* Effect.logError(`approval ${approval.id}: machine_resize payload unreadable`);
    }
    yield* Effect.forkDaemon(
      runResize(approval, approval.targetMachineId, decoded.value.fromSize, decoded.value.toSize),
    );
  });

const runResize = (approval: ApprovalResult, machineId: string, fromSize: string, toSize: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const eventBus = yield* EventBus;
    const provisioning = yield* ProvisioningServiceTag;
    const envelope = {
      id: "",
      occurredAt: new Date(),
      recordedAt: new Date(0),
      orgId: approval.orgId,
      actorType: "person" as const,
      actorId: approval.requestedByPersonId,
      machineId,
      correlationId: ulid(),
      schemaVersion: 1,
    };
    const rows = yield* dbTry("reading machine", () =>
      db.select().from(machines).where(eq(machines.id, machineId)).limit(1),
    );
    const machine = rows[0];
    if (!machine) return;

    const outcome = yield* Effect.either(
      provisioning.resize({
        machineId,
        provider: machine.provider,
        externalId: machine.externalResourceId,
        sizeSku: toSize,
        wasRunning: machine.state === "running",
      }),
    );
    if (outcome._tag === "Left") {
      const reason = String(outcome.left.cause ?? outcome.left.reason).slice(0, 500);
      yield* dbTry("recording resize failure", () =>
        db
          .update(machines)
          .set({ lastError: `resize to ${toSize} failed: ${reason}` })
          .where(eq(machines.id, machineId)),
      );
      yield* eventBus.publish([
        {
          ...envelope,
          type: "machine.resize_failed",
          payload: { fromSize, toSize, approvalId: approval.id, reason },
        } satisfies MachineEvent,
      ]);
      return;
    }
    const state = outcome.right.state === "running" ? "running" : "stopped";
    yield* dbTry("recording new size", () =>
      db
        .update(machines)
        .set({ sizeSku: toSize, state, lastError: null })
        .where(eq(machines.id, machineId)),
    );
    yield* eventBus.publish([
      {
        ...envelope,
        type: "machine.resized",
        payload: { fromSize, toSize, approvalId: approval.id },
      } satisfies MachineEvent,
    ]);
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logError(`approval ${approval.id}: resize bookkeeping failed: ${String(error)}`),
    ),
  );
