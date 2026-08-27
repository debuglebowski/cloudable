import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";

/**
 * Wire schema for the normalised evidence projection (spec §18). Kept in
 * lockstep with `./projection.ts`'s `EvidenceRecord`/`CommandRecordingRef`
 * TypeScript shapes by hand — there's exactly one of each in this unit, so
 * a codegen step would be more machinery than the duplication it removes.
 */
const ActorSchema = Schema.Struct({
  type: Schema.Literal("person", "system", "agent", "idp"),
  id: Schema.String,
});

const CommandRecordingRefSchema = Schema.Struct({
  correlationId: Schema.String,
  count: Schema.Number,
});

export const EvidenceRecordSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  occurredAt: Schema.String,
  recordedAt: Schema.String,
  orgId: Schema.String,
  actor: ActorSchema,
  machineId: Schema.NullOr(Schema.String),
  correlationId: Schema.String,
  summary: Schema.String,
  commandRecording: Schema.NullOr(CommandRecordingRefSchema),
});

export const EvidencePageSchema = Schema.Struct({
  data: Schema.Array(EvidenceRecordSchema),
  pageInfo: Schema.Struct({
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  }),
});

export const EvidenceQueryParams = Schema.Struct({
  orgId: Schema.UUID,
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
});

export const EvidenceGroup = HttpApiGroup.make("evidence").add(
  HttpApiEndpoint.get("list", "/api/v1/evidence")
    .setUrlParams(EvidenceQueryParams)
    .addSuccess(EvidencePageSchema),
);
