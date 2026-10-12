# Compliance

How the compliance surface is implemented.

**Computed live from current fleet state, not stored.** There is no `compliance_findings` table. Every request to the endpoints below re-runs the registered checks against the database at request time.

## The three-layer model

1. **Events** — facts Cloudable emits (`packages/events`, catalogued in `docs/events.md`). Not interpretations, never customer-configurable. Public, versioned, additive-only.
2. **Checks** (`ComplianceCheck`, `apps/control-plane/src/domain/compliance/types.ts`) — procedures run over events *or* current state, evaluated continuously. Registered in `apps/control-plane/src/compliance/registry.ts`.
3. **Controls** (`apps/control-plane/src/compliance/control-map.ts`) — judgements about what a check evidences. Cloudable ships one default mapping; per-control customer override is future work.

One check can evidence several controls; one control usually needs several checks. Many-to-many, expressed as `ComplianceCheck.controlRefs: string[]` — an array of control ids, not a single tag.

## The v1 checks

| # | Check id (`registry.ts`) | Fails when | Event query? |
|---|---|---|---|
| 1 | `access-revoked-on-offboarding` | A certificate is still valid 24h after the owner was offboarded | yes |
| 2 | `active-owner` | Owner absent from the IdP or deactivated | yes |
| 3 | `no-undeclared-software` | Installed packages that nothing allows and that did not ship with the image | yes |
| 4 | `elevated-access-approved` | A break-glass or admin session has no approval record and reason | yes |
| 5 | `retention-honoured` | A snapshot outlives its retention window without a legal hold | yes |
| 6 | `machines-reporting` | `lastVerifiedAt` older than the expected reconcile window | **no** |
| 7 | `vulnerabilities-remediated` | A fixable Critical or High vulnerability is open past its window, or scans are not keeping up | **no** |

Checks 1–5 belong to other feature units and are registered into `COMPLIANCE_CHECKS` as they land — this file, `control-map.ts`, and every endpoint below iterate that array generically, so they work correctly with however many of them are actually registered (including zero).

**This is a starting set, not a ceiling.** A control with no registered check displays as `manual_action_required` or `not_covered` (see below) rather than silently omitting the control.

### Check #6 — "Machines are reporting" (this unit)

`apps/control-plane/src/compliance/checks/machines-reporting.ts`.

Deliberately **not** an event query. Every other check can reasonably ask "what happened, within the retention window?" over the event log (events older than the org's event retention window are deleted; see `docs/lifecycle.md`, "Event retention"). This one can't: a machine that has *stopped* emitting anything is exactly the failure mode an events-only query would miss — the last event it ever produced would look identical whether it stopped one minute ago or one year ago. So `evaluate` reads `machines` directly:

```
state NOT IN ('archived_restorable', 'archived_expired')
AND (
  lastVerifiedAt < now() - 5 minutes
  OR (lastVerifiedAt IS NULL AND createdAt < now() - 5 minutes)
)
```

The `createdAt` branch matters: a machine defaults to `state = 'provisioning'`, `lastVerifiedAt = NULL` until the control agent's first successful poll. Without it, every machine would fail this check for the first few minutes of its life, before the agent has had any chance to report. A machine still stuck in `provisioning` past the threshold, with no report ever recorded, is correctly flagged — that's a real signal, not a startup artifact.

**Threshold**: `REPORTING_STALENESS_THRESHOLD_MINUTES = 5`, a named constant in `machines-reporting.ts`. The control agent polls roughly every 30s with exponential backoff up to a ~10 minute cap on failure. Five minutes is ~10x the happy-path poll interval — comfortably past a single missed poll or a short burst of jittered backoff, but well inside the ~10 minute cap, so a machine that has genuinely gone dark is flagged before an auditor would notice on their own, rather than only after the cap is reached.

`appliesTo` always returns `true` — any org with a live machine expects it to check in, and an org with no live machines simply produces zero findings.

Each finding: `{ checkId: "machines-reporting", machineId, detail: { lastVerifiedAt, thresholdMinutes } }`.

### Check #7 — "Vulnerabilities are fixed on time"

`apps/control-plane/src/compliance/checks/vulnerabilities-remediated.ts`. Not an event query: it
reads the scan findings and scan records the control plane keeps (see
`docs/vulnerability-scanning.md`). One finding per machine, `detailKey` the machine id, with every
reason that applies in `detail.reasons`.

It does not apply (`not_applicable`) while the org has vulnerability scanning switched off.

A machine fails when:

- `fix_overdue`: a **Critical** with a fix available has been open longer than the org's Critical
  window (7 days by default), or a **High** longer than its window (30 days by default). The
  clock starts when a fix first exists, not when the vulnerability was first seen. Vulnerabilities
  with no fix, and Medium and Low ones, are shown in the console and the export but never fail the
  check. Applies to every machine that is not archived, running or not.
- `scan_overdue`: the last completed scan is older than the longest gap between the org's scan days
  plus 24 hours (8 days for a weekly schedule). Running machines only.
- `never_scanned`: no completed scan, and more than 24 hours since the later of the machine's
  creation and the moment scanning was switched on. Running machines only.
- `database_stale`: the last scan used a vulnerability database built more than 7 days before the
  scan ran. Running machines only.

A stopped machine cannot be scanned, so it is not failed for the last three. It scans after its next
boot. `machines-reporting` is the check that notices a machine that has gone quiet.

Severity is `high`. Severity is per check here, not per finding, and an unremediated Critical or High
is the most serious thing this product reports.

A passing check says the process is working. It does not say there are no vulnerabilities: the
scanner only knows vulnerabilities that are in its database, in operating system packages.

Each finding: `{ checkId: "vulnerabilities-remediated", machineId, detail: { reasons, lastScanAt,
dbBuiltAt, remediationDays, overdueFixes, overdue } }`, where `overdue` names up to 10 of the most
overdue CVE ids. The full list is in the vulnerabilities export.

## Checks are applicability-gated

`GET /api/v1/compliance/findings` calls `appliesTo({ orgId })` for every registered check *before* `evaluate`. A check that doesn't apply renders as `not_applicable`, not `pass` — a dashboard that shows `pass` for a check that was never actually run is worse than one that's honest about `N/A`. `evaluate` only runs for checks where `appliesTo` returned `true`; both calls run concurrently across checks (`apps/control-plane/src/compliance/evaluate-all.ts`), since each check does its own independent DB round-trip.

Per-check status is exactly one of: `pass` (applies, zero open findings), `fail` (applies, ≥1 open finding), `not_applicable` (doesn't apply to this org right now).

## Finding age

Each open finding needs a stable "first seen" timestamp so the UI can show "open 14d" instead of "just now" on every poll — but "computed live, not stored" (above) means nothing about the finding itself persists between requests.

`apps/control-plane/src/compliance/finding-store.ts` is the durable bridge, backed by a real table (`complianceFindingState`, `packages/schema/src/tables/compliance-finding-state.ts`) — **it survives a control-plane restart.** `upsertFindingFirstSeen(key)` does a single atomic `INSERT ... ON CONFLICT DO UPDATE` keyed on `(checkId, orgId, machineId, detailKey)`: the first time a finding is seen the row is inserted stamped `now`; on every repeat sighting only `lastSeenAt` refreshes — `firstSeenAt` is deliberately absent from the update `set`, so a finding that keeps recurring across evaluations keeps its ORIGINAL detection time, never "now". Being one atomic upsert rather than a select-then-insert means two overlapping evaluations of the same finding can't race each other into duplicate rows or a `firstSeenAt` read that isn't really the first. `machineId: null` maps to a reserved constant (`NO_MACHINE_SENTINEL`) so the column stays real `NOT NULL` and can back a genuine unique index. `clearResolvedFindings(checkId, orgId, stillOpenDetailKeys)` deletes rows whose `detailKey` is no longer in the still-open set, so a finding that closes and later reopens is treated as newly opened rather than carrying its old age. `ageInDays(firstSeen, now)` derives the whole-day age for display.

This table is bookkeeping only, not evidence — it never substitutes for re-running a check against `events`/current state (compliance is still "computed live", above), and writes/deletes to it never touch `events` itself, which stays append-only.

## Control map

`GET /api/v1/compliance/control-map` — `apps/control-plane/src/compliance/control-map.ts`.

A small static taxonomy of controls, each mapped to a framework clause (placeholder mapping; org-level override is future work — organisation-level configuration, overridable per control):

| id | framework | in scope? |
|---|---|---|
| `access-management` | ISO 27001 A.9 | yes |
| `asset-management` | ISO 27001 A.8 | yes |
| `vulnerability-management` | ISO 27001 A.12.6 | yes |
| `hr-screening` | ISO 27001 A.7 | **no** |
| `physical-security` | ISO 27001 A.11 | **no** |
| `supplier-management` | ISO 27001 A.15 | **no** |

Status, computed purely from `COMPLIANCE_CHECKS` (no DB access needed for this endpoint):

- **`implemented`** — an in-scope control with at least one registered check whose `controlRefs` includes it.
- **`manual_action_required`** — an in-scope control with zero registered checks evidencing it right now (e.g. before another unit's check merges). Cloudable claims this control matters but currently has nothing automated backing it — a human needs to attest to it manually.
- **`not_covered`** — a control that is structurally out of scope for this product and will never be computed from `COMPLIANCE_CHECKS`, however many checks get registered. Most of ISO Annex A — physical security, HR screening, supplier contracts — has no bearing on the product and must not be claimed as evidenced. `hr-screening`, `physical-security`, and `supplier-management` above are examples, not an exhaustive list of everything Cloudable doesn't cover.

## Evidence export

`GET /api/v1/compliance/findings/export` — CSV, **grouped by control, not by time**. For every in-scope control with at least one evidencing check, lists that check's current open findings. Columns: `control, control_label, framework, check, check_label, machine_id, first_seen_at, open_days, severity, detail`.

`severity` is real, sourced from `ComplianceCheck.severity` (`apps/control-plane/src/domain/compliance/types.ts`) — a fixed, per-check editorial classification (which of the v1 checks tends to matter more if it fails: `access-revoked-on-offboarding`, `elevated-access-approved` and `vulnerabilities-remediated` are `high`; `active-owner`, `no-undeclared-software`, and `retention-honoured` are `medium`; `machines-reporting` is `low`). Every finding under the same check shares its check's severity — there is no finer-grained per-finding score. This is the one place severity is defined: both evidence CSVs and `GET /api/v1/compliance/findings` (as `ComplianceCheckResult.severity`) read it from here, rather than each keeping an independent classification.

Three named exports:

- `GET /api/v1/compliance/exports/findings.csv` — same underlying open-findings data as the main export, narrower columns: `control, check, machine_id, severity, open_since`.
- `GET /api/v1/compliance/exports/asset-inventory.csv` — one row per machine in the org: `machine_id, machine_name, owner, state, encryption_status, drift_status, patch_status, hardening_baseline, vulnerability_scan_status, last_scan_at, open_critical, open_high`.
  - `vulnerability_scan_status` is `disabled` (the org has scanning off), `current`, `overdue`, `never_scanned`, or `stopped` (the machine is not running and has no current scan, so it cannot be scanned until it boots). `last_scan_at` is the finish time of the last completed scan, empty if there is none. `open_critical` and `open_high` count open findings. The same rules as the compliance check and the console; see `docs/vulnerability-scanning.md`.
  - `hardening_baseline` is the security baseline label the machine's own agent last reported (`cis-ubuntu-l1-v1`), or `none`. See `docs/hardening.md` for what the label means, the exceptions, and the rest of the evidence table.
  - `encryption_status` is `"encrypted_at_rest"` for `provider: "azure"` machines (Azure managed disks are encrypted at rest by Storage Service Encryption unconditionally, never opted out of) and `"unknown"` for Docker/Fake, which have no such platform guarantee. `patch_status` is derived from the machine's own `upgrade_attempts` history: `"up_to_date"` (latest attempt succeeded), `"upgrade_failed"` (latest attempt rolled back/aborted), or `"never_upgraded"` (no attempt on record) — this reflects OS-image patch level, not live per-package OS-patch telemetry, which nothing in this build collects yet (see `evidence-export.ts`).
  - `drift_status` comes from the `no-undeclared-software` check (unit 8) when it's registered in `COMPLIANCE_CHECKS`: `"drifted"` if that check has an open finding for the machine, `"clean"` otherwise. Reports `"unknown"` for every machine if that check isn't registered yet, rather than guessing.

- `GET /api/v1/compliance/exports/vulnerabilities.csv` — one row per vulnerability finding, open and resolved, for every machine in the org including archived ones: `machine_id, machine_name, vulnerability_id, package, ecosystem, installed_version, fixed_version, severity, status, first_seen_at, open_days, fix_available_since, last_seen_at, resolved_at`. For a resolved finding `open_days` is how long it took to fix. Resolved rows are kept for the org's event retention window.

All three exports guard against CSV/formula injection (`apps/control-plane/src/compliance/csv.ts`): a field starting with `=`, `+`, `-`, `@`, or a tab is prefixed with `'` before quoting, since machine names and finding detail are free text that flows straight into a file auditors typically open in Excel or Sheets.

## Endpoints

All under `/api/v1/compliance/*` (`apps/control-plane/src/http/routes/compliance.ts` defines the group; `http/handlers/compliance.ts` implements it):

| Method | Path | Returns |
|---|---|---|
| GET | `/control-map` | `ControlMapResponse` (JSON) |
| GET | `/findings` | `ComplianceFindingsResponse` (JSON) |
| GET | `/findings/export` | CSV, grouped by control |
| GET | `/exports/asset-inventory.csv` | CSV |
| GET | `/exports/findings.csv` | CSV |
| GET | `/exports/vulnerabilities.csv` | CSV |

Wire types: `packages/contracts/src/domains/compliance.ts`.

Every endpoint requires a signed-in caller (a console session or a CLI token) and reads the org from that caller, never from the request (`CurrentUserAuthentication` in `http/middleware/auth.ts`). Nothing takes an `orgId`.
