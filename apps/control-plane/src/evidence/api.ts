import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { CurrentUserAuthentication } from "../http/middleware/auth";

/**
 * Wire schema for the normalised evidence projection (spec §18). Kept in
 * lockstep with `./projection.ts`'s `EvidenceRecord`/`CommandRecordingRef`/
 * `EvidenceExtensions` TypeScript shapes by hand — there's exactly one of
 * each in this unit, so a codegen step would be more machinery than the
 * duplication it removes.
 */
const ActorSchema = Schema.Struct({
  type: Schema.Literal("person", "system", "agent", "idp"),
  id: Schema.String,
});

const CommandRecordingRefSchema = Schema.Struct({
  correlationId: Schema.String,
  count: Schema.Number,
});

// `EvidenceExtensions` (./projection.ts) is a union of small string-only
// `cloud` shapes that vary per cloud event type — loosened here to a plain
// string record rather than mirroring the union case-by-case in Schema,
// since the wire contract only needs "cloud-specific string fields", not
// the TS-side per-event-type precision.
const EvidenceExtensionsSchema = Schema.Struct({
  cloud: Schema.Record({ key: Schema.String, value: Schema.String }),
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
  extensions: Schema.optional(EvidenceExtensionsSchema),
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
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
});

export const EvidenceGroup = HttpApiGroup.make("evidence")
  .add(
    HttpApiEndpoint.get("list", "/api/v1/evidence")
      .setUrlParams(EvidenceQueryParams)
      .addSuccess(EvidencePageSchema),
  )
  .middleware(CurrentUserAuthentication);
