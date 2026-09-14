import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { UnknownControlError } from "../../compliance/control-overrides-store";
import { CurrentUserAuthentication } from "../middleware/auth";

// Every endpoint here is `CurrentUserAuthentication`-gated and reads its org
// from `CurrentUserTag`. `orgId` is gone from the wire.
//
// It used to be a plain query param on a group with no middleware at all,
// which this comment described as a KNOWN GAP to close "before this API is
// exposed outside a trusted network". It was exposed: any caller who knew an
// org's UUID — and the id is in the body of every response — could read that
// org's findings, control map, and both evidence CSVs, with nothing checking
// they belonged to it.
//
// `setControlOverride` had the same gap as a WRITE: flipping another org's
// reported compliance status, marking a failing control as passing, from an
// unauthenticated request. That is the number the buyer shows the auditor.
//
// `Schema.UUID` on the old param rejected malformed ids cleanly; it never
// had anything to say about whose ids they were.

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
  medianAgeDays: Schema.NullOr(Schema.Number),
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
  // the computed default.
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
      .addSuccess(ControlMapResponse)
      .middleware(CurrentUserAuthentication),
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
      .addError(UnknownControlError, { status: 404 })
      .middleware(CurrentUserAuthentication),
  )
  .add(
    HttpApiEndpoint.get("findings", "/api/v1/compliance/findings")
      .addSuccess(ComplianceFindingsResponse)
      .middleware(CurrentUserAuthentication),
  )
  .add(
    HttpApiEndpoint.get("findingsExport", "/api/v1/compliance/findings/export")
      .addSuccess(Csv)
      .middleware(CurrentUserAuthentication),
  )
  .add(
    HttpApiEndpoint.get("assetInventoryCsv", "/api/v1/compliance/exports/asset-inventory.csv")
      .addSuccess(Csv)
      .middleware(CurrentUserAuthentication),
  )
  .add(
    HttpApiEndpoint.get("findingsCsv", "/api/v1/compliance/exports/findings.csv")
      .addSuccess(Csv)
      .middleware(CurrentUserAuthentication),
  );
