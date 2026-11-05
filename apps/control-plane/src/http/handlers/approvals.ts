import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { Effect } from "effect";
import { carryOutApproved } from "../../domain/approvals/carry-out";
import { NotPermittedError, isApproverOrAdmin, requireAdminUser } from "../../domain/authz";
import {
  type ApprovalError,
  type ApprovalResult,
  ApprovalService,
} from "../../services/ApprovalService";
import { Api } from "../api";
import { type CurrentUser, CurrentUserTag } from "../middleware/auth";
import { toApprovalWire } from "../routes/approvals";

const mapError = (error: ApprovalError) => {
  switch (error.reason) {
    case "not_found":
      return new HttpApiError.NotFound();
    case "already_decided":
    case "duplicate_decision":
      return new HttpApiError.Conflict();
    case "reason_required":
      return new HttpApiError.BadRequest();
    // `self_approval`/`conflict_of_interest` cannot reach here: only `decide` compares the
    // caller against the request, and it uses `mapDecideError` below.
    case "self_approval":
    case "conflict_of_interest":
    case "query_failed":
    case "insert_failed":
      return new HttpApiError.InternalServerError();
  }
};

/** `decide` only. 403 rather than 409: the request is well-formed and the approval is
 * decidable — just not by this person. A conflict would read as "try again later", which
 * is the wrong advice; nothing changes by waiting. */
const mapDecideError = (error: ApprovalError) =>
  error.reason === "self_approval"
    ? new NotPermittedError({ reason: "Nobody can decide a request they made themselves." })
    : error.reason === "conflict_of_interest"
      ? new NotPermittedError({
          reason: "Nobody can decide a request about themselves or about a machine they own.",
        })
      : mapError(error);

/** Approvers and admins see every request. Anyone else sees only the ones they made. */
const canSeeApproval = (user: CurrentUser, approval: ApprovalResult): boolean =>
  isApproverOrAdmin(user) || approval.requestedByPersonId === user.personId;

const toWire = toApprovalWire;

export const ApprovalsLive = HttpApiBuilder.group(Api, "approvals", (handlers) =>
  handlers
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        // The action types this endpoint takes (restore, offboarding, break-glass, admin
        // access) are all admin actions. Their own endpoints check the details again.
        yield* requireAdminUser(currentUser, "Only an admin can ask for this approval.");
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.request({
          orgId: currentUser.orgId,
          actionType: payload.actionType,
          requestedByPersonId: currentUser.personId,
          targetMachineId: payload.targetMachineId,
          reason: payload.reason,
        });
        return toWire(result);
      }).pipe(Effect.catchTag("ApprovalError", (error) => Effect.fail(mapError(error)))),
    )
    .handle("decide", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        if (!isApproverOrAdmin(currentUser)) {
          return yield* Effect.fail(
            new NotPermittedError({ reason: "Only an approver or an admin can decide requests." }),
          );
        }
        const approvalService = yield* ApprovalService;
        // A change to approval settings needs an approver specifically: the admin who asked
        // for it must not be able to have another admin wave it through.
        const existing = yield* approvalService.status(path.id, currentUser.orgId);
        if (existing.actionType === "approval_settings_change" && !currentUser.approver) {
          return yield* Effect.fail(
            new NotPermittedError({
              reason: "Only an approver can sign off a change to approval settings.",
            }),
          );
        }
        const result = yield* approvalService.decide(
          path.id,
          currentUser.orgId,
          currentUser.personId,
          payload.decision,
          payload.reason,
        );
        yield* carryOutApproved(result);
        return toWire(result);
      }).pipe(Effect.catchTag("ApprovalError", (error) => Effect.fail(mapDecideError(error)))),
    )
    .handle("getById", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.status(path.id, currentUser.orgId);
        if (!canSeeApproval(currentUser, result))
          return yield* Effect.fail(new HttpApiError.NotFound());
        return toWire(result);
      }).pipe(Effect.catchTag("ApprovalError", (error) => Effect.fail(mapError(error)))),
    )
    .handle("list", ({ urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.list({
          orgId: currentUser.orgId,
          status: urlParams.status,
          requestedByPersonId: isApproverOrAdmin(currentUser) ? undefined : currentUser.personId,
          cursor: urlParams.cursor,
          limit: urlParams.limit,
        });
        return {
          items: result.items.map(toWire),
          pageInfo: { nextCursor: result.nextCursor, hasMore: result.hasMore },
        };
      }).pipe(Effect.catchTag("ApprovalError", (error) => Effect.fail(mapError(error)))),
    ),
);
