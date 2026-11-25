# Inheritance: org → profile → machine

Policy inheritance and the package manifest. See `apps/control-plane/src/domain/machine/*`,
`apps/control-plane/src/domain/profile/*`, and
`packages/schema/src/tables/{setting,machine-package,profile}.ts`.

## The chain

Every setting and every package manifest entry lives at one of three **scopes**:

```
org  →  profile  →  machine
```

**Lowest level wins.** A machine-level row overrides a profile-level row, which overrides an
org-level row. There is no partial merge within one setting or one package entry — resolution
picks exactly one row per key, from the lowest scope that has one. A **lock** on a row stops any
scope below it from overriding it (see Locking below).

## Profiles

A profile is a named set of settings and packages that machines link to. It replaced the old
placeholder name "template": a template sounds like something copied once, and a profile is not
copied. Edit a profile and every machine on it follows, unless that machine overrides the setting.

- A machine has zero or one profile (`machines.profileId`). An admin picks it when creating the
  machine, and can move the machine later (`PUT /api/v1/machines/:id/profile`). Each move is
  recorded as `machine.profile_assigned`. A move is refused for an archived machine, and when the
  new profile sets a provider, region, size or image the machine does not have.
- A profile's settings are `setting_values` rows with `scopeType: "profile"`, written through
  `PATCH /api/v1/config/settings`. A profile may set only the keys in `PROFILE_SETTING_KEYS`
  (`domain/profile/setting-keys.ts`): logging tier, access methods and the elevation length.
  Everything else is org-wide: event retention, approval modes, vulnerability scanning, the Nix
  snapshot, the Ensure retry wait, malware protection, and the admin access policy.
  `machine.persistentPaths` is left out because nothing acts on it yet.
- `clear: true` on that endpoint deletes a profile's own value, so its machines take the org's
  again. It is recorded as `profile.setting_changed` with `current: null`.
- A profile's packages are `machine_packages` rows with `scopeType: "profile"`, written through
  `PATCH /api/v1/profiles/:id/packages` (`updateOrgPackages` with a `profileId`). Moving one to
  an Ensure setting needs the same `package_ensure` approval as on the org. Moving a machine onto
  a profile installs that profile's Ensure packages with no new approval: they were approved when
  they were set.
- **Creation fields.** A profile may set a provider, region, size and image. All are optional.
  They are used only when a machine is created: the create form asks for what the profile leaves
  blank, and refuses a value that differs from the profile's. They cannot change while a machine
  that is not archived uses the profile. To change them, make a new profile. A profile edit must
  never resize or move a live machine (invariant 10).
- Profiles are archived, never deleted (`POST /api/v1/profiles/:id/archive`). No new machine can
  use an archived profile. Machines already on it keep reading their settings from it.
- Restoring an archived machine into a new one keeps its profile while that profile is usable and
  still fits the machine's fields. Otherwise the new machine starts on none.
- Only admins create, edit, archive or move. Anyone in the org may read a profile.
- Events: `profile.created`, `profile.updated`, `profile.setting_changed`, `profile.archived`,
  `machine.profile_assigned`. `machine.created` carries `profileId`.

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
  chain: { orgId: string; profileId?: string | null; machineId: string },
): ResolvedSetting<T> | undefined
```

It looks for a `machine`-scoped row for `key` first, then (if `chain.profileId` is set) a
`profile`-scoped row, then an `org`-scoped row, and returns the first match with its `value` and
`source`. No row at any scope means `undefined` — there is no default baked into the function
itself.

**The package manifest reuses this function rather than reimplementing the chain walk.**
`resolveManifest()` (`apps/control-plane/src/domain/machine/manifest.ts`) treats each distinct
`packageName` across a machine's `org`/`profile`/`machine`-scoped `machine_packages` rows as a
`resolveSetting()` key:

```ts
const settingRows: ReadonlyArray<SettingRow<PackageManifestValue>> = rows.map((row) => ({
  scopeType: row.scopeType,
  scopeId: row.scopeId,
  key: row.packageName,          // the package name IS the setting key
  value: { versionPin: row.versionPin, locked: row.locked },
  source: row.source,
}));
```

...then calls `resolveSetting(packageName, settingRows, chain)` once per distinct package name and
collects the winners. This is why `machinePackages` is its own table rather than rows inside
`settingValues` keyed by a `pkg:<name>` string convention: a manifest is a *set* of independently
addable/removable named entries (not one keyed value), so it gets a table shaped like the domain
concept — while still sharing the exact same resolution algorithm, not a parallel one that could
drift from it.

## What a package manifest entry says

A manifest entry says a machine **may** have a package, and optionally pins the version it may have
(`docker`, `nodejs 20`). Each entry also has a setting. The setting says what Cloudable does about
the package:

- **Allowed** (`allowed`, the default). A machine may have it. Nothing installs it until a person
  asks.
- **Ensure installed** (`ensure_installed`). Cloudable installs it when it is missing. It never
  updates it.
- **Ensure latest version** (`ensure_latest`). Cloudable installs it when it is missing. It also
  updates it when the package repository has a newer version.

Nothing else moves a machine towards its manifest. An Allowed package is installed or removed only
when a person asks, per package (`domain/machine/package-actions.ts`). Each action is recorded as a
request, an outcome, and a failure if there was one.

Who may ask: the machine's owner, or an admin. An install also needs an approval
(`package_install`, one approver by default, set on the Organisation page) and is queued only
once it is approved (`domain/machine/package-request.ts`). A removal is queued at once. Which
packages a machine *may* have, and their settings, are configuration. So only an admin edits a
manifest, at either scope.

That split is why a machine's packages table has two independent columns. A package can be allowed
and absent because nobody has installed it yet. It can be present and disallowed because somebody
installed it anyway. The second is exactly what the compliance check is looking for.
There is no dependency resolution here; that is the machine's own package manager's job. Rows
live in `machinePackages`, one per `(scopeType, scopeId, packageName)` (enforced by a unique index,
`machine_packages_scope_package_idx`), which is also the upsert key `MachineService.updatePackages`
writes against.

The HTTP-editable surface for this unit is `PATCH /api/v1/machines/:id/packages`
(`apps/control-plane/src/http/routes/machines.ts`), which only ever writes `machine`-scoped rows.
The org's own defaults are edited through `PATCH /api/v1/organisation/packages`
(`domain/organisation/packages.ts`); the schema, `resolveManifest()`, and the lock check below are
scope-generic and shared by both.

## Ensure settings

The two Ensure settings are the only way Cloudable installs a declared package without a person
asking for it at that moment. The rules are in `domain/machine/package-ensure.ts` and
`domain/machine/ensure.ts`.

### Setting one

- An edit sends `setting` on an upsert, at org or machine scope. An omitted `setting` keeps the
  current value.
- Moving a package to an Ensure setting needs a `package_ensure` approval. So does moving between
  the two. The mode is set on the Organisation page. The default is `single`.
- That edit is not written until the approval is granted. The response lists it under
  `ensureApprovals`, with the approval id and its status. Other edits in the same request apply at
  once.
- When the org's mode is `none`, the approval is granted at once and the edit is written.
- Moving back to Allowed applies at once. It cannot make Cloudable install anything.
- The installs an Ensure setting causes need no approval of their own. The setting's approval
  covers them.
- Only apt packages can be ensured. The one list is `INSTALLABLE_PACKAGE_MANAGERS` in
  `packages/contracts`. Ensuring any other name is refused with a 422 `invalid_ensure_setting`.
- Ensure latest version with a version pin is refused the same way. The two contradict each other.
- Ensure installed with a version pin installs the pinned version.
- Both checks run before any approval is asked for. An approver is never asked about an edit that
  would then be refused.

### What gets queued, and when

Each time the agent reports, the control plane looks at every Ensure package on that machine
(`MachineService.ensurePackages`). It queues an install in two cases:

- The package is missing. This applies to both Ensure settings.
- The setting is Ensure latest version, and the version the repository offers differs from the
  installed one.

The agent reports what the repository offers (`availablePackageVersions`). It reads it with
`apt-cache policy`. It never runs `apt-get update` itself. So "newer" means newer in the package
lists the machine already has. Ubuntu refreshes those daily.

Ensure installed never updates a package. It does not change an installed version that differs
from its pin either.

Each queued install is recorded as `machine.package_action_requested`. Its actor is `system`. Its
payload says which setting caused it (`trigger`), whether the package was missing or outdated
(`ensureReason`), and the versions it moves between (`fromVersion`, `toVersion`). The people
behind it are on the setting's approval and its `setting_changed` event.

Nothing is queued for:

- an excluded entry, or a part whose parent is not allowed
- a package the machine's image shipped with
- a package that already has an action waiting or running
- a package whose last Ensure action finished less than five minutes ago. A report already on its
  way can still describe the machine from before the action.
- an archived machine

### When an install fails

After an Ensure install fails or expires, Cloudable waits before it tries again. The wait is the
org setting `packages.ensureRetryHours`. It is 1 to 720 hours. The default is 24. An admin changes
it with `PATCH /api/v1/organisation` (`ensureRetryHours`). The change is recorded as
`org.setting_changed`.

An update can succeed and still leave the package behind, for example when apt holds it. Cloudable
then waits the same time before it tries that update again.

The machine's packages view shows the wait. A row has `ensureFailure` with `failedAt`, `reason` and
`nextAttemptAt`. It also has `setting` and `availableVersion`.

### Removing an ensured package

A request to uninstall a package set to Ensure is refused with `ensured_package`. Cloudable would
install it straight back. Set it to Allowed first.

### Older agents

An agent from before this feature does not report what the repository offers. Its machine still
gets missing Ensure packages installed. It does not get Ensure latest version updates.

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
that row back would leave a machine-level entry declaring "any version", quietly shadowing
the org's version pin from then on. Undoing an exclusion has to put the machine back where it started, which
is inheriting.

Excluding is an override like any other, so a lock above blocks it: `findLockConflicts()` sees the
edited package name and rejects the whole edit with the same 422 below. A machine that could opt out
of a locked package would make the lock decorative.

## Locking

**The org or a profile can lock an entry.** A locked entry cannot be overridden *below* its own
scope: an org lock binds profiles and machines, a profile lock binds its machines. Trying to
override one is a validation error at edit time, not a silent no-op later. "Locked" was called
"pinned" until 2026-11; it was renamed because it clashed with version pins (`nodejs 20`), which
are a different thing. Recorded events keep the old field name `pinned` in their payloads, so every
change on record has one shape.

**Settings.** `applySettingChange` refuses a machine-scope write when the org's or the machine's
profile's row for that key is locked, and a profile-scope write when the org's row is locked
(`LockedSettingError`, 409). This applies to every key.

**Packages.** `findLockConflicts()` (`apps/control-plane/src/domain/machine/manifest.ts`), given the
existing rows relevant to an edit and the package names it touches, reports a conflict for every
edited name that has a `locked: true` row at a **strictly higher** scope than the edit's target.
Editing at the same scope that owns the lock, or at a higher scope than any existing lock, is not
"below" and is never reported.

`MachineService.updatePackages` and `updateOrgPackages` run this check before writing anything: if
any conflict is found, the whole edit is rejected with `PackageLockConflictError`, serialized as
**`422 Unprocessable Entity`**:

```jsonc
{
  "error": {
    "code": "locked_entry_conflict",
    "message": "1 package(s) are locked above the machine scope and cannot be overridden below.",
    "requestId": "...",
    "details": { "conflicts": [{ "packageName": "docker", "lockedAtScope": "org", "lockedAtScopeId": "...", "lockedVersionPin": "24" }] }
  }
}
```

No row is written and no event is emitted when this happens. This is deliberately
**edit-time-only**: a lock does not retroactively change what `resolveManifest()` returns for a
row written *before* the lock was set. Reconcile never silently drops such a row either. The lock
only ever blocks a *new* write attempt.

## Allowlist detection

`buildPackagesView` / `undeclaredFromView` (`apps/control-plane/src/domain/machine/packages-view.ts`)
are the pure data path behind both the machine's packages table and the "no undeclared software"
check: given a resolved manifest, the inventory the agent reported, and the image baseline, they
return what is installed that nothing allows and that did not ship with the image.

Subtracting the baseline is what makes the answer usable. A real Ubuntu server image carries several
hundred packages; without it, every machine reports several hundred findings on its first check-in.

Dependencies are subtracted too. The agent reports which installed packages someone asked for on
purpose (`apt-mark showmanual`). Anything else came in because one of those needed it, and is judged
through the package that pulled it in. Declaring `build-essential` therefore does not leave gcc, make
and binutils reading as undeclared. A package named on an install command line is marked manual by
apt, so it is still judged on its own. Two limits: a dependency left behind after its parent is
removed is not flagged, and an agent that cannot tell (no apt, or an older agent) reports nothing, so
every installed package counts, as before.

### Other package managers, and the home folder

A manifest entry is an apt name, or `<manager>:<name>` for anything else (`PACKAGE_MANAGERS` in
`packages/contracts/src/domains/agent-protocol.ts`). apt names cannot contain a colon, so existing
names keep their meaning.

| Prefix | What | Reported by the agent |
| :--- | :--- | :--- |
| none | apt package | yes, `dpkg-query` |
| `npm:` | global npm tool (`npm:@openai/codex`) | yes, `npm ls -g` as the machine's user |
| `pipx:` | pipx tool | yes, `pipx list` as the machine's user |
| `cargo:` | `cargo install`ed crate | yes, `cargo install --list` as the machine's user |
| `nix:` | package in the machine user's Nix profile, by nixpkgs attribute (`nix:ripgrep`, `nix:python3Packages.black`) | yes, `nix profile list` as the machine's user |
| `home:` | software in the home folder no manager knows about (Playwright's Chromium) | no, declaration only |

Only global tools. Project dependencies (`node_modules`, virtualenvs) are not reported, and nothing
scans folders, so a `home:` entry is a record of what is allowed, never a detection.

### Installing through other managers

apt, npm, pipx, cargo and Nix packages can all be installed through Cloudable, by a person or by
an Ensure setting (`INSTALLABLE_PACKAGE_MANAGERS` in the contracts package). `home:` cannot. The
same `package_install` approval covers every manager.

apt runs as root. The other four run as the machine user (`apps/agent/src/user-package-actions.ts`),
because that is where their tools live and where the agent reads them from, and so package install
scripts never run as root.

- **The manager must already be there.** Cloudable never installs one on its own. A person asks
  for `npm`, `pipx`, `cargo` or `nix-setup-systemd` through apt first. Without it the install
  fails with "npm is not installed for user cloudable".
- **npm.** Ubuntu's npm installs global tools into `/usr/local`, which the user cannot write. Before
  the first Cloudable npm install, if the user's global folder is not writable, the agent points
  it at `~/.local` in the user's `~/.npmrc` and says so in the action result. The inventory reads
  both `~/.local` and `/usr/local`, so a tool installed with sudo earlier still counts. Every
  npm, pipx and cargo command runs in the user's home, so a project's `.npmrc` or
  `.cargo/config.toml` never decides where a tool goes.
- **cargo.** Compiles from source, so its actions may run for up to 35 minutes before they
  expire. Ubuntu 24.04's cargo is Rust 1.75, and many current crates need a newer one: the
  install then fails with cargo's own "requires rustc 1.88 or newer". Pin an older version of the
  crate, or have the person use rustup. While the org scans tools (scope `os_and_tools`), the
  agent puts cargo-auditable on the machine right before the install, and the install goes
  through it so the result can be scanned.
- **Nix** needs Ubuntu 24.04 (Nix 2.18). Ubuntu 22.04's Nix 2.6 is refused. Installing the apt
  package `nix-setup-systemd` also adds the machine user to `nix-users`, which the Nix daemon
  requires, and writes `/etc/profile.d/cloudable-nix.sh` to put `~/.nix-profile/bin` on PATH.
  Both are part of that one recorded action, and removing the package undoes them.

**Version pins per manager.** A pin on an npm, pipx or cargo package is a version in that
manager's own syntax (`^3.3.0`, `24.1.0`). apt pins are free text, as before. A Nix pin is
different: Nix has no per-package version. A **nixpkgs commit** fixes the version of every package
in it. So an org sets one commit, `packages.nix.snapshot` (an admin, on the Organisation page or
`cloudable org update --nix-snapshot <commit>`), and every machine's `nix:` packages install from
it. Moving it forward is how Nix packages get newer versions, and what *Ensure latest version*
means for them. A `nix:` entry's own pin, a full 40-character commit, wins over the org's. With
neither set, a Nix install is refused rather than take whatever nixpkgs is newest that day.

Running actions expire per manager and per batch (`expiredActionIds` in
`domain/machine/package-actions.ts`). The agent runs one poll's actions one at a time, so an apt
install handed out together with a cargo build gets the build's time as well as its own.

### Parts

An entry can name another declared entry as its parent (`partOf`). A part is allowed only while its
parent is: not excluded, present in the resolved manifest, and itself allowed if it is a part. Remove
or exclude the parent and every part reads as undeclared again. A cycle of parts allows nothing. The
parent can be from another manager and another scope: `xvfb` and `home:playwright-chromium` are
parts of `npm:playwright`. This is for links apt cannot see. Plain apt dependencies need no part
entry, as above. `allowedPackageNames` in `domain/machine/manifest.ts` is the one rule, used by the
check, the packages table and the allowed list the agent polls.

One definition, two consumers, deliberately: the table a person looks at and the finding an auditor
reads are computed by the same function, so they cannot disagree. Neither has any license to act.
Removing a package is always an explicit per-package action someone asked for. Ensure settings only
ever install. They never remove undeclared software.

## Events

`MachineService` emits `machine.created` on creation and one `machine.setting_changed` event per
edited package name on a successful `updatePackages` call (all sharing one `correlationId` per
request) — see `apps/control-plane/src/domain/machine/events.ts`. Each `machine.setting_changed`
payload's `previous`/`current` are the resolved value
(`{ versionPin, pinned, excluded, partOf, description, setting }` or `null` if the package isn't in
the manifest on that side) computed via `resolveManifest()` *before* and
*after* the write, and `overridesLevel` is the `source` of the *previous* resolved value (or
`"none"` if the package had no prior resolved value at all) — i.e. which level's effective value
this edit just superseded. `org.setting_changed` for an org package carries the org entry: `packageName`, `versionPin`,
`pinned`, `partOf`, `description` and `setting`. Events
recorded before settings existed have no `setting`. Those packages were all Allowed.

An Ensure setting that waited for approval is written, and its event recorded, when the approval is
granted. The event is attributed to the person who asked, not the approver.

An install that an Ensure setting causes is recorded as `machine.package_action_requested` with
actor `system`. See "Ensure settings" above for its payload.

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
