import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { UnknownControlError } from "../../compliance/control-overrides-store";

// orgId is a plain query param rather than derived from `CurrentUserTag`
// because auth isn't wired to any endpoint yet (see
// `http/middleware/auth.ts`) — every compliance endpoint below is
// org-scoped by this param until that lands. KNOWN GAP: nothing here
// verifies the caller actually belongs to `orgId` — any caller can read any
// org's findings/exports by passing its id. This must be closed (scope the
// param to `CurrentUserTag.orgId`, or add an authz check) before this API is
// exposed outside a trusted network. `Schema.UUID` at least rejects
// malformed ids with a clean decode error instead of a raw DB error.
//
// `setControlOverride` below inherits this SAME gap, but as a WRITE rather
// than a read: today, any caller who knows (or enumerates) another org's
// UUID can flip that org's reported compliance status via `orgId` in its
// payload, with nothing checking the caller actually belongs to that org.
// This is strictly worse than the read-only gap above and must be closed
// the same way (scope to `CurrentUserTag.orgId`) before this endpoint is
// exposed outside a trusted network — flagged explicitly here rather than
// silently inheriting the read-only framing above.
const OrgScopedParams = Schema.Struct({ orgId: Schema.UUID });

const ComplianceFindingDto = Schema.Struct({
  machineId: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.String,
  ageDays: Schema.Number,
  detail: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const ComplianceCheckResult = Schema.Struct({
  checkId: Schema.String,
  label: Schema.String,
  controlRefs: Schema.Array(Schema.String),
  status: Schema.Literal("pass", "fail", "not_applicable"),
  findings: Schema.Array(ComplianceFindingDto),
});

const ComplianceFindingsResponse = Schema.Struct({
  orgId: Schema.String,
  generatedAt: Schema.String,
  checks: Schema.Array(ComplianceCheckResult),
});

const ControlStatus = Schema.Literal("implemented", "manual_action_required", "not_covered");

const ControlMapEntry = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  framework: Schema.String,
  status: ControlStatus,
  evidencedByCheckIds: Schema.Array(Schema.String),
  // True when `status` came from this org's explicit override rather than
  // the computed default (docs/spec.md §19).
  overridden: Schema.Boolean,
  // True when this control is eligible for an override at all — false for a
  // structurally out-of-scope control (see `OVERRIDABLE_CONTROL_IDS` in
  // `control-map.ts`). The console uses this to avoid offering an override
  // action that `setControlOverride` below will always reject.
  overridable: Schema.Boolean,
});

const ControlMapResponse = Schema.Struct({
  controls: Schema.Array(ControlMapEntry),
});

const ControlOverridePathParams = Schema.Struct({ controlId: Schema.String });

// `null` clears this org's override for the control, reverting it to the
// computed default — same "absent means default" convention the DB layer
// uses (see `control-overrides-store.ts`).
const SetControlOverridePayload = Schema.Struct({
  orgId: Schema.UUID,
  status: Schema.NullOr(ControlStatus),
});

const Csv = Schema.String.pipe(
  HttpApiSchema.withEncoding({ kind: "Text", contentType: "text/csv; charset=utf-8" }),
);

/**
 * `/api/v1/compliance/*` — control map, per-check findings, and evidence
 * exports. See `docs/compliance.md` for the events -> checks -> controls
 * model and export formats.
 */
export const ComplianceGroup = HttpApiGroup.make("compliance")
  .add(
    HttpApiEndpoint.get("controlMap", "/api/v1/compliance/control-map")
      .setUrlParams(OrgScopedParams)
      .addSuccess(ControlMapResponse),
  )
  .add(
    // Sets or clears (via `status: null`) one org's override for one control
    // — always returns the full, freshly-recomputed control map so the
    // console can just replace its cache with the response.
    HttpApiEndpoint.patch(
      "setControlOverride",
      "/api/v1/compliance/control-map/:controlId/override",
    )
      .setPath(ControlOverridePathParams)
      .setPayload(SetControlOverridePayload)
      .addSuccess(ControlMapResponse)
      .addError(UnknownControlError, { status: 404 }),
  )
  .add(
    HttpApiEndpoint.get("findings", "/api/v1/compliance/findings")
      .setUrlParams(OrgScopedParams)
      .addSuccess(ComplianceFindingsResponse),
  )
  .add(
    HttpApiEndpoint.get("findingsExport", "/api/v1/compliance/findings/export")
      .setUrlParams(OrgScopedParams)
      .addSuccess(Csv),
  )
  .add(
    HttpApiEndpoint.get("assetInventoryCsv", "/api/v1/compliance/exports/asset-inventory.csv")
      .setUrlParams(OrgScopedParams)
      .addSuccess(Csv),
  )
  .add(
    HttpApiEndpoint.get("findingsCsv", "/api/v1/compliance/exports/findings.csv")
      .setUrlParams(OrgScopedParams)
      .addSuccess(Csv),
  );
