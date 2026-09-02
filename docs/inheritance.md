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

## The package manifest

A manifest entry names a package and **optionally** pins a version (`docker`, `nodejs 20`).
There is no dependency resolution here; that is the machine's own package manager's job. Rows
live in `machinePackages`, one per `(scopeType, scopeId, packageName)` (enforced by a unique index,
`machine_packages_scope_package_idx`), which is also the upsert key `MachineService.updatePackages`
writes against.

The HTTP-editable surface for this unit is `PATCH /api/v1/machines/:id/packages`
(`apps/control-plane/src/http/routes/machines.ts`), which only ever writes `machine`-scoped rows —
editing an org's own manifest defaults is a different unit's concern (whatever owns the
organisation-settings surface), though the schema, `resolveManifest()`, and the pin check below are
already scope-generic and need no changes when that lands.

## Pinning

**An org (or, once it exists, a template) can mark an entry `pinned`.** A pinned entry cannot be
overridden *below* its own scope: *"Attempting to override one is a validation error
at edit time, not a silent no-op at reconcile."*

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
drops such a row either (reconcile only closes gaps against declared
state and never auto-corrects); the pin only ever blocks a *new* write attempt.

## Allowlist detection

`computeUndeclaredPackages(manifest, reported)`
(`apps/control-plane/src/domain/machine/manifest.ts`) is the pure data path behind the "no
undeclared software" check and the reconcile loop's removal set: given a resolved manifest and a
list of package names the agent reported as actually installed, it returns the reported names that
aren't declared anywhere in the chain. It has no DB or HTTP dependency and no license to act on its
own output — only the reconcile loop (unit 1) may *remove* what this
function reports, and only compliance (unit 8) may *surface* it as a finding; this function itself
only computes the set.

## Events

`MachineService` emits `machine.created` on creation and one `machine.setting_changed` event per
edited package name on a successful `updatePackages` call (all sharing one `correlationId` per
request) — see `apps/control-plane/src/domain/machine/events.ts`. Each `machine.setting_changed`
payload's `previous`/`current` are the resolved value (`{ versionPin, pinned }` or `null` if the
package isn't in the manifest on that side) computed via `resolveManifest()` *before* and *after*
the write, and `overridesLevel` is the `source` of the *previous* resolved value (or `"none"` if the
package had no prior resolved value at all) — i.e. which level's effective value this edit just
superseded.
