// ---------------------------------------------------------------------------
// Role checks for HTTP handlers. The rules live in `@cloudable/contracts`
// (`domains/roles.ts`) so the console hides exactly what the control plane
// refuses. This module turns them into Effects a handler can `yield*`.
//
// Two failures, both declared on every endpoint by `http/api.ts`:
//
//   - `MachineNotVisibleError` (404): the caller may not see this machine at
//     all. Same answer as a machine that does not exist, so a member cannot
//     learn which machine ids are real.
//   - `NotPermittedError` (403): the caller can see the thing but may not do
//     this to it, or is not allowed this kind of action at all.
//
// `AdminRoleRequiredError` (403, `domain/people/authorization.ts`) is kept for
// the admin-only checks, since the console already reads it.
// ---------------------------------------------------------------------------
import {
  type MachineAction,
  type RoleSubject,
  canActOnMachine,
  canDecideApprovals,
  canSeeMachine,
  isAdminRole,
} from "@cloudable/contracts";
import { machines } from "@cloudable/schema";
import { HttpApiSchema } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Db } from "../../db/layer";
import type { CurrentUser } from "../../http/middleware/auth";
import { AdminRoleRequiredError } from "../people/authorization";

export class NotPermittedError extends Schema.TaggedError<NotPermittedError>()(
  "NotPermittedError",
  { reason: Schema.String },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class MachineNotVisibleError extends Schema.TaggedError<MachineNotVisibleError>()(
  "MachineNotVisibleError",
  { machineId: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export const subjectOf = (user: CurrentUser): RoleSubject => ({
  personId: user.personId,
  role: user.role,
  approver: user.approver,
});

export const isAdmin = (user: CurrentUser): boolean => isAdminRole(user.role);

export const isApproverOrAdmin = (user: CurrentUser): boolean =>
  canDecideApprovals(subjectOf(user));

/** Fails unless the caller is an admin. The role was read live by the auth middleware. */
export const requireAdminUser = (
  user: CurrentUser,
  reason = "Only an admin can do this.",
): Effect.Effect<void, AdminRoleRequiredError> =>
  isAdmin(user) ? Effect.void : Effect.fail(new AdminRoleRequiredError({ reason }));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MachineAccessRow {
  readonly id: string;
  readonly orgId: string;
  readonly ownerPersonId: string | null;
}

const ACTION_REFUSAL: Record<MachineAction, string> = {
  connect: "Only the machine's owner can connect to it.",
  archive:
    "Only the machine's owner can archive it. To archive someone else's machine, offboard them.",
  restart: "Only the machine's owner or an admin can restart it.",
  upgrade: "Only the machine's owner or an admin can upgrade it.",
  snapshot: "Only the machine's owner or an admin can take a snapshot of it.",
  packages: "Only the machine's owner or an admin can ask for a package change.",
  editManifest: "Only an admin can change which packages a machine may have.",
};

/**
 * Reads the machine and checks the caller against it. Fails with `MachineNotVisibleError` when the
 * machine does not exist, is in another org, or is not the caller's to see; with
 * `NotPermittedError` when they can see it but not do `action`. `action` omitted means "see it".
 */
export const authorizeMachine = (
  user: CurrentUser,
  machineId: string,
  action?: MachineAction,
): Effect.Effect<MachineAccessRow, MachineNotVisibleError | NotPermittedError, Db> =>
  Effect.gen(function* () {
    if (!UUID_PATTERN.test(machineId)) {
      return yield* Effect.fail(new MachineNotVisibleError({ machineId }));
    }
    const db = yield* Db;
    const rows = yield* Effect.tryPromise(() =>
      db
        .select({ id: machines.id, orgId: machines.orgId, ownerPersonId: machines.ownerPersonId })
        .from(machines)
        .where(eq(machines.id, machineId))
        .limit(1),
    ).pipe(Effect.orDie);
    const machine = rows[0];
    const subject = subjectOf(user);
    if (!machine || machine.orgId !== user.orgId || !canSeeMachine(subject, machine)) {
      return yield* Effect.fail(new MachineNotVisibleError({ machineId }));
    }
    if (action !== undefined && !canActOnMachine(subject, machine, action)) {
      return yield* Effect.fail(new NotPermittedError({ reason: ACTION_REFUSAL[action] }));
    }
    return machine;
  });

/** Whether the caller may see everything of a kind (admin), or only their own. */
export const ownOnlyFilter = (user: CurrentUser): string | undefined =>
  isAdmin(user) ? undefined : user.personId;
