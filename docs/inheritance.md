# Inheritance: org → template → machine

Policy inheritance and the package manifest. Owned by unit 2 (machine desired-state
API + package manifest); see `apps/control-plane/src/domain/machine/*`,
`packages/schema/src/tables/{setting,machine-package}.ts`.

## The chain

Every setting and every package manifest entry lives at one of three **scopes**:

```
org  →  template  →  machine
```

**Lowest level wins.** A machine-level row overrides a template-level row, which overrides an
org-level row. There is no partial merge within one setting or one package entry — resolution
picks exactly one row per key, from the lowest scope that has one.

**The template layer is inert in v1** (see `CLAUDE.md` — "Not in v1: No templates"). It exists in
the data model — `machines.templateId` is a nullable column from the first migration
(`packages/schema/src/tables/machine.ts`), `settingValues.scopeType` and `machinePackages.scopeType`
both accept `"template"` as a value, and `resolveSetting()`'s chain walk already checks the template
scope — but nothing in this build ever writes a `template`-scoped row, because there is no
`templates` table yet and no UI or API creates one. The chain is *organisation → machine* in
practice today. When the template layer ships, no schema migration or resolution-function change is
needed — only something that starts writing `scopeType: "template"` rows.

**No wizard prefill.** A machine is created with an empty manifest and empty setting overrides; it
*inherits* org defaults live through resolution, it does not *copy* them at creation time. A later
change to an org default is immediately visible on every machine that hasn't overridden it — this
is the whole point of resolving at read time rather than prefilling at creation time. See
`MachineService.create` (`apps/control-plane/src/domain/machine/MachineService.ts`) — it inserts
only the `machines` row itself, never any `machine_packages` or `setting_values` rows.

## The `source` field convention

Both `settingValues` (`packages/schema/src/tables/setting.ts`) and `machinePackages`
(`packages/schema/src/tables/machine-package.ts`) carry two scope-shaped fields that look similar
but answer different questions:

- **`scopeType` / `scopeId`** — *where this row is declared.* A row with `scopeType: "org"` was
  written against the org; a row with `scopeType: "machine"` was written against one specific
  machine. This is a property of the row itself, fixed at write time.
- **`source`** — *which scope's row won resolution*, attached to the *resolved* value returned by
  `resolveSetting()`, not to a raw row. For a raw `settingValues`/`machinePackages` row, `source`
  is currently always equal to that row's own `scopeType` (a row can only ever be the winner for
  its own scope), but the two fields exist separately because a future scope kind (e.g. a
  SCIM-synced value, per `docs/cloud-auth.md`-adjacent identity work) could populate `source` with
  something that isn't a chain-scope literal, without needing a fourth `scopeType`.

The wire contract (`packages/contracts/src/domains/machines.ts`) exposes `source` on every
*resolved* manifest entry (`ResolvedPackageManifestEntry`) precisely so the console's
`LineageGutter`/`SettingRow` components (`docs/frontend.md`) can render "this came from org" vs.
"this is a machine-level override" without a separate lookup. `LineageGutter`'s `source: Level`
prop is fed directly from this field.

## `resolveSetting()` — the one resolution algorithm

`packages/schema/src/resolve-setting.ts` is the single implementation of "lowest level wins" in the
codebase. Its shape:

```ts
export function resolveSetting<T>(
  key: string,
  rows: ReadonlyArray<SettingRow<T>>,
  chain: { orgId: string; templateId?: string | null; machineId: string },
): ResolvedSetting<T> | undefined
```

It looks for a `machine`-scoped row for `key` first, then (if `chain.templateId` is set) a
`template`-scoped row, then an `org`-scoped row, and returns the first match with its `value` and
`source`. No row at any scope means `undefined` — there is no default baked into the function
itself.

**The package manifest reuses this function rather than reimplementing the chain walk.**
`resolveManifest()` (`apps/control-plane/src/domain/machine/manifest.ts`) treats each distinct
`packageName` across a machine's `org`/`template`/`machine`-scoped `machine_packages` rows as a
`resolveSetting()` key:

```ts
const settingRows: ReadonlyArray<SettingRow<PackageManifestValue>> = rows.map((row) => ({
  scopeType: row.scopeType,
  scopeId: row.scopeId,
  key: row.packageName,          // the package name IS the setting key
  value: { versionPin: row.versionPin, pinned: row.pinned },
  source: row.source,
}));
```

...then calls `resolveSetting(packageName, settingRows, chain)` once per distinct package name and
collects the winners. This is why `machinePackages` is its own table rather than rows inside
`settingValues` keyed by a `pkg:<name>` string convention: a manifest is a *set* of independently
addable/removable named entries (not one keyed value), so it gets a table shaped like the domain
concept — while still sharing the exact same resolution algorithm, not a parallel one that could
drift from it.

## The package manifest is permission, not desired state

A manifest entry says a machine **may** have a package, and optionally pins the version it may have
(`docker`, `nodejs 20`). It does not say the package will be installed, and nothing converges a
machine towards it. Installing and removing are explicit per-package actions a person takes
(`domain/machine/package-actions.ts`), each one recorded as a request, an outcome, and a failure if
there was one.

That split is why a machine's packages table has two independent columns. A package can be allowed
and absent because nobody has installed it yet, or present and disallowed because somebody
installed it anyway — and the second is exactly what the compliance check is looking for.
There is no dependency resolution here; that is the machine's own package manager's job. Rows
live in `machinePackages`, one per `(scopeType, scopeId, packageName)` (enforced by a unique index,
`machine_packages_scope_package_idx`), which is also the upsert key `MachineService.updatePackages`
writes against.

The HTTP-editable surface for this unit is `PATCH /api/v1/machines/:id/packages`
(`apps/control-plane/src/http/routes/machines.ts`), which only ever writes `machine`-scoped rows.
The org's own defaults are edited through `PATCH /api/v1/organisation/packages`
(`domain/organisation/packages.ts`); the schema, `resolveManifest()`, and the pin check below are
scope-generic and shared by both.

## Removing, and excluding

These are different edits and resolve differently:

- **Removing** (`removals`) deletes this machine's own row. If the org declares the package, the
  machine goes straight back to inheriting it. Removal means "stop overriding", not "get rid of it".
- **Excluding** (`excluded: true` on an upsert) writes a machine row saying the package must not be
  here, which beats the org's entry. There is no way to express this by removing a row, since the
  absence of a row already means "inherit".

An excluded entry still resolves — the console renders it and offers to lift it — but it is not
*declared*. `declaredPackages()` (`domain/machine/manifest.ts`) is the effective install set, and
every caller that means "what this machine may have" goes through it: what the provider is asked
to create (`MachineService.create`), the allowed list served to the agent on poll, and undeclared
software detection. So a package that is excluded and installed
anyway reads as undeclared software and surfaces as drift, which is the point of excluding it.

Lifting an exclusion that is all the machine row ever said deletes the row rather than rewriting it
as `excluded: false`. Excluding a package the machine had no row for writes one with no version of
its own (the upsert fallback reads the machine's own row, never the chain — see below), so flipping
that row back would leave a machine-level entry declaring "any version, unpinned", quietly shadowing
the org's pin from then on. Undoing an exclusion has to put the machine back where it started, which
is inheriting.

Excluding is an override like any other, so an org pin blocks it: `findPinConflicts()` sees the
edited package name and rejects the whole edit with the same 422 below. A machine that could opt out
of a pinned package would make the pin decorative.

## Pinning

**An org (or, once it exists, a template) can mark an entry `pinned`.** A pinned entry cannot be
overridden *below* its own scope: *"Attempting to override one is a validation error
at edit time, not a silent no-op later."*

This is enforced by `findPinConflicts()` (`apps/control-plane/src/domain/machine/manifest.ts`):
given the full set of existing rows relevant to a machine and the package names an edit touches, it
reports a conflict for every edited name that has a `pinned: true` row at a **strictly higher**
scope than the edit's target (org/template pinning blocks a machine edit; org pinning blocks a
template edit). Editing at the same scope that owns the pin, or at a higher scope than any existing
pin, is not "below" and is never reported.

`MachineService.updatePackages` runs this check before writing anything: if any conflict is found,
the whole edit is rejected with `PackagePinConflictError` — serialized by the HTTP layer as
**`422 Unprocessable Entity`**, body:

```jsonc
{
  "error": {
    "code": "pinned_entry_conflict",
    "message": "1 package(s) are pinned above the machine scope and cannot be overridden below.",
    "requestId": "...",
    "details": { "conflicts": [{ "packageName": "docker", "pinnedAtScope": "org", "pinnedAtScopeId": "...", "pinnedVersionPin": "24" }] }
  }
}
```

No row is written and no event is emitted when this happens — the edit fails atomically, before any
`machine_packages` write. This is deliberately **edit-time-only**: pinning does not retroactively
change what `resolveManifest()` returns for a machine-level row that was written *before* the pin
was set (a machine can still be resolving its own pre-existing override). Reconcile never silently
drops such a row either — nothing converges a machine towards its manifest at all; the pin only
ever blocks a *new* write attempt.

## Allowlist detection

`buildPackagesView` / `undeclaredFromView` (`apps/control-plane/src/domain/machine/packages-view.ts`)
are the pure data path behind both the machine's packages table and the "no undeclared software"
check: given a resolved manifest, the inventory the agent reported, and the image baseline, they
return what is installed that nothing allows and that did not ship with the image.

Subtracting the baseline is what makes the answer usable. A real Ubuntu server image carries several
hundred packages; without it, every machine reports several hundred findings on its first check-in.

One definition, two consumers, deliberately: the table a person looks at and the finding an auditor
reads are computed by the same function, so they cannot disagree. Neither has any license to act —
removing a package is always an explicit per-package action someone asked for.

## Events

`MachineService` emits `machine.created` on creation and one `machine.setting_changed` event per
edited package name on a successful `updatePackages` call (all sharing one `correlationId` per
request) — see `apps/control-plane/src/domain/machine/events.ts`. Each `machine.setting_changed`
payload's `previous`/`current` are the resolved value (`{ versionPin, pinned, excluded }` or `null`
if the package isn't in the manifest on that side) computed via `resolveManifest()` *before* and
*after* the write, and `overridesLevel` is the `source` of the *previous* resolved value (or
`"none"` if the package had no prior resolved value at all) — i.e. which level's effective value
this edit just superseded.

Both write paths namespace the event's `key` as `package:<name>` (`packageSettingKey()`), the org
path via `orgPackageSettingKey`, which now re-exports it. The prefix is load-bearing in two places:

- `logging/tier-filter.ts` never drops a `machine.setting_changed` carrying one. Without that, an
  org on logging tier 1 would keep every org-level package change (`org.setting_changed` is tier 1)
  and silently discard every per-machine one (tier 2), leaving the manifest history on a machine's
  own page with holes in it that nothing in the product explains.
- `GET /api/v1/machines/:id/manifest-history` (`domain/machine/manifest-history.ts`) selects on it.
  That endpoint is a read-only projection over the event log: every package change affecting one
  machine, newest first, its own rows and the org's. Org rows are included because an org edit
  changes what the machine resolves to, and `org.setting_changed` carries `machineId: null`, so it
  could not reach a machine-filtered view any other way. Edits recorded before the machine path
  adopted the prefix are keyed by a bare package name and do not appear there; they are still in the
  raw event stream on the Audit page.
