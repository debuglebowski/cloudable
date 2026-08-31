# Compliance

Implementation detail for `docs/spec.md` §19 ("Compliance surface"). Read that section first — this file is the "how", not the "why".

**Computed live from current fleet state, not stored.** There is no `compliance_findings` table. Every request to the endpoints below re-runs the registered checks against the database at request time.

## The three-layer model

1. **Events** — facts Cloudable emits (`packages/events`, catalogued in `docs/events.md`). Not interpretations, never customer-configurable. Public, versioned, additive-only (invariant #11).
2. **Checks** (`ComplianceCheck`, `apps/control-plane/src/domain/compliance/types.ts`) — procedures run over events *or* current state, evaluated continuously. Registered in `apps/control-plane/src/compliance/registry.ts`.
3. **Controls** (`apps/control-plane/src/compliance/control-map.ts`) — judgements about what a check evidences. Cloudable ships one default mapping; per-control customer override is future work.

One check can evidence several controls; one control usually needs several checks. Many-to-many, expressed as `ComplianceCheck.controlRefs: string[]` — an array of control ids, not a single tag.

## The six v1 checks

| # | Check id (`registry.ts`) | Fails when | Event query? |
|---|---|---|---|
| 1 | `access-revoked-on-offboarding` | A certificate is still valid 24h after the owner was offboarded | yes |
| 2 | `active-owner` | Owner absent from the IdP or deactivated | yes |
| 3 | `no-undeclared-software` | Installed packages diverge from the resolved manifest | yes |
| 4 | `elevated-access-approved` | A break-glass or admin session has no approval record and reason | yes |
| 5 | `retention-honoured` | A snapshot outlives its retention window without a legal hold | yes |
| 6 | `machines-reporting` | `lastVerifiedAt` older than the expected reconcile window | **no** |

Checks 1–5 belong to other feature units and are registered into `COMPLIANCE_CHECKS` as they land — this file, `control-map.ts`, and every endpoint below iterate that array generically, so they work correctly with however many of the six are actually registered (including zero).

**Six is a starting set, not a ceiling.** A control with no registered check displays as `manual_action_required` or `not_covered` (see below) rather than silently omitting the control.

### Check #6 — "Machines are reporting" (this unit)

`apps/control-plane/src/compliance/checks/machines-reporting.ts`.

Deliberately **not** an event query. Every other check can reasonably ask "what happened, ever?" over the append-only event log. This one can't: a machine that has *stopped* emitting anything is exactly the failure mode an events-only query would miss — the last event it ever produced would look identical whether it stopped one minute ago or one year ago. So `evaluate` reads `machines` directly:

```
state NOT IN ('archived_restorable', 'archived_expired')
AND (
  lastVerifiedAt < now() - 5 minutes
  OR (lastVerifiedAt IS NULL AND createdAt < now() - 5 minutes)
)
```

The `createdAt` branch matters: a machine defaults to `state = 'provisioning'`, `lastVerifiedAt = NULL` until the control agent's first successful poll. Without it, every machine would fail this check for the first few minutes of its life, before the agent has had any chance to report. A machine still stuck in `provisioning` past the threshold, with no report ever recorded, is correctly flagged — that's a real signal, not a startup artifact.

**Threshold**: `REPORTING_STALENESS_THRESHOLD_MINUTES = 5`, a named constant in `machines-reporting.ts`. The control agent polls roughly every 30s with exponential backoff up to a ~10 minute cap on failure (`docs/spec.md` §8.1). Five minutes is ~10x the happy-path poll interval — comfortably past a single missed poll or a short burst of jittered backoff, but well inside the ~10 minute cap, so a machine that has genuinely gone dark is flagged before an auditor would notice on their own, rather than only after the cap is reached.

`appliesTo` always returns `true` — any org with a live machine expects it to check in, and an org with no live machines simply produces zero findings.

Each finding: `{ checkId: "machines-reporting", machineId, detail: { lastVerifiedAt, thresholdMinutes } }`.

## Checks are applicability-gated

`GET /api/v1/compliance/findings` calls `appliesTo({ orgId })` for every registered check *before* `evaluate`. A check that doesn't apply renders as `not_applicable`, not `pass` — a dashboard that shows `pass` for a check that was never actually run is worse than one that's honest about `N/A`. `evaluate` only runs for checks where `appliesTo` returned `true`; both calls run concurrently across checks (`apps/control-plane/src/compliance/evaluate-all.ts`), since each check does its own independent DB round-trip.

Per-check status is exactly one of: `pass` (applies, zero open findings), `fail` (applies, ≥1 open finding), `not_applicable` (doesn't apply to this org right now).

## Finding age

Each open finding needs a stable "first seen" timestamp so the UI can show "open 14d" instead of "just now" on every poll — but "computed live, not stored" (above) means nothing about the finding itself persists between requests.

`apps/control-plane/src/compliance/finding-store.ts` is the durable bridge, backed by a real table (`complianceFindingState`, `packages/schema/src/tables/compliance-finding-state.ts`) — **it survives a control-plane restart.** `upsertFindingFirstSeen(key)` does a single atomic `INSERT ... ON CONFLICT DO UPDATE` keyed on `(checkId, orgId, machineId, detailKey)`: the first time a finding is seen the row is inserted stamped `now`; on every repeat sighting only `lastSeenAt` refreshes — `firstSeenAt` is deliberately absent from the update `set`, so a finding that keeps recurring across evaluations keeps its ORIGINAL detection time, never "now". Being one atomic upsert rather than a select-then-insert means two overlapping evaluations of the same finding can't race each other into duplicate rows or a `firstSeenAt` read that isn't really the first. `machineId: null` maps to a reserved constant (`NO_MACHINE_SENTINEL`) so the column stays real `NOT NULL` and can back a genuine unique index. `clearResolvedFindings(checkId, orgId, stillOpenDetailKeys)` deletes rows whose `detailKey` is no longer in the still-open set, so a finding that closes and later reopens is treated as newly opened rather than carrying its old age. `ageInDays(firstSeen, now)` derives the whole-day age for display.

This table is bookkeeping only, not evidence — it never substitutes for re-running a check against `events`/current state (compliance is still "computed live", above), and writes/deletes to it never touch `events` itself, which stays append-only (invariant #2).

## Control map

`GET /api/v1/compliance/control-map` — `apps/control-plane/src/compliance/control-map.ts`.

A small static taxonomy of controls, each mapped to a framework clause (placeholder mapping; org-level override is future work, per `docs/spec.md` §19: "Organisation-level configuration, overridable per control"):

| id | framework | in scope? |
|---|---|---|
| `access-management` | ISO 27001 A.9 | yes |
| `asset-management` | ISO 27001 A.8 | yes |
| `hr-screening` | ISO 27001 A.7 | **no** |
| `physical-security` | ISO 27001 A.11 | **no** |
| `supplier-management` | ISO 27001 A.15 | **no** |

Status, computed purely from `COMPLIANCE_CHECKS` (no DB access needed for this endpoint):

- **`implemented`** — an in-scope control with at least one registered check whose `controlRefs` includes it.
- **`manual_action_required`** — an in-scope control with zero registered checks evidencing it right now (e.g. before another unit's check merges). Cloudable claims this control matters but currently has nothing automated backing it — a human needs to attest to it manually.
- **`not_covered`** — a control that is structurally out of scope for this product and will never be computed from `COMPLIANCE_CHECKS`, however many checks get registered. Per `docs/spec.md` §19: "Most of ISO Annex A — physical security, HR screening, supplier contracts — has no bearing on the product and must not be claimed as evidenced." `hr-screening`, `physical-security`, and `supplier-management` above are examples, not an exhaustive list of everything Cloudable doesn't cover.

## Evidence export

`GET /api/v1/compliance/findings/export` — CSV, **grouped by control, not by time** (`docs/spec.md` §19). For every in-scope control with at least one evidencing check, lists that check's current open findings. Columns: `control, control_label, framework, check, check_label, machine_id, first_seen_at, open_days, severity, detail`.

`severity` is real, sourced from `ComplianceCheck.severity` (`apps/control-plane/src/domain/compliance/types.ts`) — a fixed, per-check editorial classification (which of the six v1 checks tends to matter more if it fails: `access-revoked-on-offboarding` and `elevated-access-approved` are `high`; `active-owner`, `no-undeclared-software`, and `retention-honoured` are `medium`; `machines-reporting` is `low`). Every finding under the same check shares its check's severity — there is no finer-grained per-finding score. This is the one place severity is defined: both evidence CSVs and `GET /api/v1/compliance/findings` (as `ComplianceCheckResult.severity`) read it from here, rather than each keeping an independent classification.

Two named exports (`docs/spec.md` §19, "Exports"):

- `GET /api/v1/compliance/exports/findings.csv` — same underlying open-findings data as the main export, narrower columns: `control, check, machine_id, severity, open_since`.
- `GET /api/v1/compliance/exports/asset-inventory.csv` — one row per machine in the org: `machine_id, machine_name, owner, state, encryption_status, drift_status, patch_status`.
  - `encryption_status` and `patch_status` are explicit fixed placeholders (`true` / `"unknown"`) — no encryption-status or patch-status signal exists anywhere in the system yet (no event, no column on `machines`), so these columns intentionally report a fixed value rather than guessing one.
  - `drift_status` comes from the `no-undeclared-software` check (unit 8) when it's registered in `COMPLIANCE_CHECKS`: `"drifted"` if that check has an open finding for the machine, `"clean"` otherwise. Reports `"unknown"` for every machine if that check isn't registered yet, rather than guessing.

All three exports guard against CSV/formula injection (`apps/control-plane/src/compliance/csv.ts`): a field starting with `=`, `+`, `-`, `@`, or a tab is prefixed with `'` before quoting, since machine names and finding detail are free text that flows straight into a file auditors typically open in Excel or Sheets.

## Endpoints

All under `/api/v1/compliance/*` (`apps/control-plane/src/http/routes/compliance.ts` defines the group; `http/handlers/compliance.ts` implements it):

| Method | Path | Returns |
|---|---|---|
| GET | `/control-map` | `ControlMapResponse` (JSON) |
| GET | `/findings?orgId=` | `ComplianceFindingsResponse` (JSON) |
| GET | `/findings/export?orgId=` | CSV, grouped by control |
| GET | `/exports/asset-inventory.csv?orgId=` | CSV |
| GET | `/exports/findings.csv?orgId=` | CSV |

Wire types: `packages/contracts/src/domains/compliance.ts`.

**Known gap**: `orgId` is a plain, unauthenticated query param — auth isn't wired to any endpoint yet (`http/middleware/auth.ts` is a stub). Until it is, any caller can read any org's findings and exports by passing its id. `orgId` is validated as a UUID (`Schema.UUID`), so a malformed id gets a clean `400` instead of a raw Postgres error, but that's a format check, not an authorization one. Closing this means scoping these endpoints to `CurrentUserTag.orgId` once auth lands, not trusting the param.
