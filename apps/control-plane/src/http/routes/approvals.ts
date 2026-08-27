import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

const ActionType = Schema.Literal("snapshot_restore", "break_glass", "admin_access", "offboarding");
const Mode = Schema.Literal("none", "single", "dual");
const Status = Schema.Literal("pending", "approved", "rejected", "expired");
const DecisionValue = Schema.Literal("approved", "rejected");

/** Wire shape of an approval — mirrors `@cloudable/contracts`' `ApprovalResource`. */
const ApprovalResource = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  actionType: ActionType,
  mode: Mode,
  status: Status,
  requestedByPersonId: Schema.String,
  targetMachineId: Schema.NullOr(Schema.String),
  reason: Schema.String,
  requiredApprovals: Schema.Number,
  approvedCount: Schema.Number,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
});

const CreateApprovalPayload = Schema.Struct({
  orgId: Schema.UUID,
  actionType: ActionType,
  requestedByPersonId: Schema.UUID,
  targetMachineId: Schema.NullOr(Schema.UUID),
  reason: Schema.String.pipe(Schema.minLength(1)),
});

const DecideApprovalPayload = Schema.Struct({
  personId: Schema.UUID,
  decision: DecisionValue,
  reason: Schema.optional(Schema.String),
});

const ListApprovalsUrlParams = Schema.Struct({
  orgId: Schema.optional(Schema.String),
  status: Schema.optional(Status),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
});

const ListApprovalsResponse = Schema.Struct({
  items: Schema.Array(ApprovalResource),
  pageInfo: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
});

// Every endpoint may fail with any of these — see `http/handlers/approvals.ts`'s
// `mapError` for which `ApprovalError` reasons map to which status.
const create = HttpApiEndpoint.post("create", "/api/v1/approvals")
  .setPayload(CreateApprovalPayload)
  .addSuccess(ApprovalResource)
  .addError(HttpApiError.NotFound)
  .addError(HttpApiError.Conflict)
  .addError(HttpApiError.BadRequest)
  .addError(HttpApiError.InternalServerError);

const decide = HttpApiEndpoint.post(
  "decide",
)`/api/v1/approvals/${HttpApiSchema.param("id", Schema.String)}/decide`
  .setPayload(DecideApprovalPayload)
  .addSuccess(ApprovalResource)
  .addError(HttpApiError.NotFound)
  .addError(HttpApiError.Conflict)
  .addError(HttpApiError.BadRequest)
  .addError(HttpApiError.InternalServerError);

const getById = HttpApiEndpoint.get(
  "getById",
)`/api/v1/approvals/${HttpApiSchema.param("id", Schema.String)}`
  .addSuccess(ApprovalResource)
  .addError(HttpApiError.NotFound)
  .addError(HttpApiError.Conflict)
  .addError(HttpApiError.BadRequest)
  .addError(HttpApiError.InternalServerError);

const list = HttpApiEndpoint.get("list", "/api/v1/approvals")
  .setUrlParams(ListApprovalsUrlParams)
  .addSuccess(ListApprovalsResponse)
  .addError(HttpApiError.NotFound)
  .addError(HttpApiError.Conflict)
  .addError(HttpApiError.BadRequest)
  .addError(HttpApiError.InternalServerError);

export const ApprovalsGroup = HttpApiGroup.make("approvals")
  .add(create)
  .add(decide)
  .add(getById)
  .add(list);
