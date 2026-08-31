import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

// orgId is a plain query param rather than derived from `CurrentUserTag`
// because auth isn't wired to any endpoint yet (see
// `http/middleware/auth.ts`) — every compliance endpoint below is
// org-scoped by this param until that lands. KNOWN GAP: nothing here
// verifies the caller actually belongs to `orgId` — any caller can read any
// org's findings/exports by passing its id. This must be closed (scope the
// param to `CurrentUserTag.orgId`, or add an authz check) before this API is
// exposed outside a trusted network. `Schema.UUID` at least rejects
// malformed ids with a clean decode error instead of a raw DB error.
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
  severity: Schema.Literal("low", "medium", "high"),
  findings: Schema.Array(ComplianceFindingDto),
});

const ComplianceFindingsResponse = Schema.Struct({
  orgId: Schema.String,
  generatedAt: Schema.String,
  checks: Schema.Array(ComplianceCheckResult),
});

const ControlMapEntry = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  framework: Schema.String,
  status: Schema.Literal("implemented", "manual_action_required", "not_covered"),
  evidencedByCheckIds: Schema.Array(Schema.String),
});

const ControlMapResponse = Schema.Struct({
  controls: Schema.Array(ControlMapEntry),
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
    HttpApiEndpoint.get("controlMap", "/api/v1/compliance/control-map").addSuccess(
      ControlMapResponse,
    ),
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
