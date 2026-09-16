import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { Effect } from "effect";
import {
  type ApprovalError,
  type ApprovalResult,
  ApprovalService,
} from "../../services/ApprovalService";
import { Api } from "../api";
import { CurrentUserTag } from "../middleware/auth";

const mapError = (error: ApprovalError) => {
  switch (error.reason) {
    case "not_found":
      return new HttpApiError.NotFound();
    case "already_decided":
    case "duplicate_decision":
      return new HttpApiError.Conflict();
    case "reason_required":
      return new HttpApiError.BadRequest();
    // `self_approval` cannot reach here: only `decide` compares the caller against the
    // requester, and it uses `mapDecideError` below. Folding it into this shared mapper
    // would make every endpoint declare a 403 it can never return.
    case "self_approval":
    case "query_failed":
    case "insert_failed":
      return new HttpApiError.InternalServerError();
  }
};

/** `decide` only. 403 rather than 409: the request is well-formed and the approval is
 * decidable — just not by this person. A conflict would read as "try again later", which
 * is the wrong advice; nothing changes by waiting. */
const mapDecideError = (error: ApprovalError) =>
  error.reason === "self_approval" ? new HttpApiError.Forbidden() : mapError(error);

const toWire = (result: ApprovalResult) => ({
  ...result,
  createdAt: result.createdAt.toISOString(),
  expiresAt: result.expiresAt.toISOString(),
  decidedAt: result.decidedAt ? result.decidedAt.toISOString() : null,
});

export const ApprovalsLive = HttpApiBuilder.group(Api, "approvals", (handlers) =>
  handlers
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.request({
          orgId: currentUser.orgId,
          actionType: payload.actionType,
          requestedByPersonId: currentUser.personId,
          targetMachineId: payload.targetMachineId,
          reason: payload.reason,
        });
        return toWire(result);
      }).pipe(Effect.mapError(mapError)),
    )
    .handle("decide", ({ path, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.decide(
          path.id,
          currentUser.orgId,
          currentUser.personId,
          payload.decision,
          payload.reason,
        );
        return toWire(result);
      }).pipe(Effect.mapError(mapDecideError)),
    )
    .handle("getById", ({ path }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.status(path.id, currentUser.orgId);
        return toWire(result);
      }).pipe(Effect.mapError(mapError)),
    )
    .handle("list", ({ urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUserTag;
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.list({
          orgId: currentUser.orgId,
          status: urlParams.status,
          cursor: urlParams.cursor,
          limit: urlParams.limit,
        });
        return {
          items: result.items.map(toWire),
          pageInfo: { nextCursor: result.nextCursor, hasMore: result.hasMore },
        };
      }).pipe(Effect.mapError(mapError)),
    ),
);
