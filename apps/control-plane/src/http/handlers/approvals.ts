import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { Effect } from "effect";
import {
  type ApprovalError,
  type ApprovalResult,
  ApprovalService,
} from "../../services/ApprovalService";
import { Api } from "../api";

const mapError = (error: ApprovalError) => {
  switch (error.reason) {
    case "not_found":
      return new HttpApiError.NotFound();
    case "already_decided":
    case "duplicate_decision":
      return new HttpApiError.Conflict();
    case "reason_required":
      return new HttpApiError.BadRequest();
    case "query_failed":
    case "insert_failed":
      return new HttpApiError.InternalServerError();
  }
};

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
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.request({
          orgId: payload.orgId,
          actionType: payload.actionType,
          requestedByPersonId: payload.requestedByPersonId,
          targetMachineId: payload.targetMachineId,
          reason: payload.reason,
        });
        return toWire(result);
      }).pipe(Effect.mapError(mapError)),
    )
    .handle("decide", ({ path, payload }) =>
      Effect.gen(function* () {
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.decide(
          path.id,
          payload.personId,
          payload.decision,
          payload.reason,
        );
        return toWire(result);
      }).pipe(Effect.mapError(mapError)),
    )
    .handle("getById", ({ path }) =>
      Effect.gen(function* () {
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.status(path.id);
        return toWire(result);
      }).pipe(Effect.mapError(mapError)),
    )
    .handle("list", ({ urlParams }) =>
      Effect.gen(function* () {
        const approvalService = yield* ApprovalService;
        const result = yield* approvalService.list({
          orgId: urlParams.orgId,
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
