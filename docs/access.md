# Access

How access methods are implemented: the SSH CA, `cloudable login`, signed
session tokens, and the web terminal / tunnel daemon's control-plane side.

## Roles: who may see and do what

Every person has a role, `member` or admin (`owner` or `admin`). On top of that, any person can
be an **approver** (`people.approver`). The rules live in `packages/contracts/src/domains/roles.ts`.
The control plane checks them on every request (`apps/control-plane/src/domain/authz`). The
console only hides what a person cannot use.

**A member** sees and works on their own machine only. They cannot see anyone else's machine, not
even that it exists: the API answers 404. They cannot create a machine.

**An admin** runs the org. People, settings, integrations, audit, archive and compliance are
admin only. An admin creates a machine for a person. The owner must be an active person of the
org with no other live machine. An admin has **no live access** to someone else's machine: no
terminal, no files, no SSH, no snapshot inspection.

**An approver** decides approval requests. Admins can decide them too. Nobody decides a request
they made, a request about themselves, or a request about a machine they own. A change to
approval settings needs an approver specifically, not just any admin.

| On a machine | Owner | Admin (not owner) | Anyone else |
| :--- | :--- | :--- | :--- |
| See it | yes | yes | no (404) |
| Connect: terminal, files, SSH | yes | no | no |
| Inspect a snapshot | yes | no | no |
| Archive | yes | only by offboarding the owner | no |
| Restart, upgrade, take a snapshot | yes | yes | no |
| Ask for a package install or removal | yes | yes | no |
| Change which packages it may have | no | yes | no |
| Restore a snapshot | yes, to the same owner | yes, to the same owner | no |

Every one of these is recorded with the person who did it.

| Elsewhere | Member | Approver | Admin |
| :--- | :--- | :--- | :--- |
| Machines list | own only | own only | all |
| Access page: sessions, certificates | own only | own only | all |
| Approvals | own requests | all, and decide | all, and decide |
| People list | themselves only | all | all, and edit |
| Audit, Archive, Integrations, Organisation, compliance | no | no | yes |
| Any setting, at org or machine scope | no | no | yes |

### Live access is the owner's alone

`ADMIN_ACCESS_POLICY` (`config.ts`, set by Terraform) decides whether an admin can ever get an
elevation on someone else's machine. It defaults to `never`, and production pins it there. It is
not a setting: the API refuses to write `admin_access_policy`, and an old setting row is ignored.
The policy is checked when a session opens, not only when an elevation is asked for, so a grant
from before the pin opens nothing.

A machine with no owner (after offboarding) is open to nobody.

### Break-glass

Break-glass is outside Cloudable, through Azure PIM (Privileged Identity Management). An operator
activates an Azure role with MFA and a written justification. PIM records it and tells the
Security Delegates. See `cloudable-deploy/README.md` for who is eligible.

**Not done yet:** today PIM in `cloudable-deploy` covers the Key Vault roles only. There is no
PIM-eligible role on the machines resource group (`rg-cloudable-managed`) for reaching a VM. Until
there is, break-glass to a machine means a standing Azure role, which is not the control this
section describes.

This is also the honest limit of the rule above. Anyone with Azure rights on that resource group
can run commands on a VM or copy its disk without Cloudable seeing it.

### Sign-in

Production signs in through Entra SSO only. Email and password sign-in is off whenever the
deployment declares an identity provider (`PASSWORD_SIGN_IN`, default off then).

A deactivated person is refused on every request (401) and cannot create a sign-in account.

Only an admin can change a person's email. A console session is matched to a person by email, so
whoever can change an email can sign in as someone else. When an admin changes one, every console
session and CLI token the person held is revoked (`people.credentials_revoked_at`) and a
`person.email_changed` event is written.

### Roles from the identity provider

Off by default. The operator who deploys Cloudable can turn it on. Then the identity provider (IdP)
decides every person's role and approver flag, not admins in Cloudable. Role definitions and what
each role may do stay Cloudable's (the tables above); the IdP decides who holds which.

Cloudable implements the shared IdP role contract (`@normain/idp-role-contract` 0.1.0, vendored in
`vendor/`, see `vendor/README.md`), the same release Kahuna and SlayZone pin. Config parsing, claim
reading, role mapping, the freshness rule and the audit event shape come from it. Cloudable's own
parts are in `apps/control-plane/src/idp-roles/`.

**Sign-in.** SSO only, through the IdP declared in deployment config, over SAML. Password sign-in
is forced off. Every verified SAML sign-in reads the role attribute and sets the person's role and
approver flag:

- Values map exactly, case included, through `IDP_ROLE_MAPPING`. Unknown values are ignored.
- Several mapped roles: the highest wins (`owner`, then `admin`, then `member`). A value mapped to
  `approver` adds the approver flag. The flag alone is not a role.
- No mapped role (no attribute, an empty one, only unknown values, or only `approver`): the
  sign-in is refused and the login page says why. The person also becomes a member without the
  flag, their role evidence is cleared, and every console session, CLI token, CLI sign-in code and
  SSH certificate they hold ends. They get back in once the IdP gives them a role.

**The hourly recheck.** A role holds only while it rests on a verified assertion younger than
`IDP_RECHECK_INTERVAL_SECONDS` (default and maximum 3600). Cloudable stores, per person, when their
last accepted assertion was issued, by its own signed `IssueInstant`
(`people.idp_roles_verified_at`). The shared contract's rule decides freshness, in whole seconds:
evidence is stale from the start of second `floor(verified) + interval`. Every way in checks it
itself, not a background job:

- every API request, from the console's session cookie and from CLI bearer tokens
  (`http/middleware/auth.ts`), and the web terminal's websocket attach, which runs the same check;
- a CLI sign-in code when `cloudable login` redeems it (`http/handlers/access.ts`);
- open terminal, files and SSH tunnels (`http/handlers/tunnel.ts`): a watcher ends each one at
  its person's exact deadline without reading anything first, re-reads the person every 10
  seconds before that (revocation, deactivation, a fresh SSO extending the deadline), and treats a
  failed or slow read as a lapse. Every frame in both directions is also checked against the
  deadline, so nothing reaches the machine or the browser after it. The 60-second expiry sweep
  (`tunnel/relay.ts`) stays as a backstop for sessions whose watcher is gone (a replica that died);
- SSH certificates, which never last past the person's deadline.

Past the deadline the API answers 401 `idp_reauthentication_required`. The console starts a fresh
SSO sign-in that comes back to the same page; with the IdP's own session still open this needs no
password or MFA prompt. The CLI says to run `cloudable login`. There is no refresh token in SAML,
so a new verified assertion is the only renewal. A change at the IdP therefore applies within the
interval, or at the next sign-in if sooner.

**What makes an assertion count as evidence.** `@better-auth/sso` verifies the signature (the
assertion itself must be signed in this mode), audience, recipient, destination, NotBefore and
NotOnOrAfter (required), and that the Response's `InResponseTo` names an AuthnRequest this
deployment issued less than 5 minutes ago, each usable once. Unsolicited IdP-initiated responses
are refused. Used assertion IDs and consumed requests are stored in the database, so a restart
forgets neither.

The Response's `InResponseTo` is not covered by the assertion's signature, so on its own it does
not prove the assertion was issued for that request. Cloudable therefore also reads the signed
assertion's own fields (`idp-roles/saml-assertion.ts`, checked in the sign-in hook after the
plugin's checks pass):

- exactly one plaintext assertion (encrypted assertions are not supported in this mode);
- every bearer `SubjectConfirmationData` carries `InResponseTo`, equal to the request the plugin
  consumed, so the signed assertion itself answers that request and an older signed assertion
  cannot be re-wrapped in a new envelope;
- its signed `IssueInstant` is at most 5 minutes old (60 seconds of future clock skew allowed),
  not older than the evidence already recorded, and strictly after both the current activation
  and the person's last credential revocation. An assertion signed for a request made before an
  activation or a revocation counts for nothing, even inside its 5 minutes. Activation also drops
  every pending AuthnRequest, so such a request cannot be answered at all.

The IdP must therefore put `InResponseTo` on `SubjectConfirmationData` (Entra ID, Okta, Google and
Keycloak do for SP-initiated sign-in) and sign the assertion. Only the provider declared in
deployment config carries roles; a sign-in through any other is refused. `saml-acs.integration.test.ts`
runs all of this through the real endpoint with real signed XML.

**Replicas must agree (the mode fence).** Every request, CLI code redemption and live tunnel
compares this replica's config with the persisted mode (`idp-roles/mode-fence.ts`). A replica whose
config does not match (mode off while the persisted mode is on, on while it is off, or a different
fingerprint) answers every authenticated request with 401 `idp_roles_config_mismatch`, refuses SSO
sign-ins with `idp_roles_config_changed`, and keeps no tunnel open. So during a rollout that
switches the mode, changes its config, or rotates IdP certificates, old replicas stop serving as
soon as the first new one applies the activation. Roll out every replica with the same config; a
mismatch is a refusal, not a fallback. Off everywhere and never switched on: no change.

**Switching the mode on (activation).** At startup the control plane compares its config with the
persisted mode (`idp_role_mode`). Switching it on, or changing anything role evidence depends on
while on (the claim, the mapping, the interval, or the IdP's provider id, entity id, SSO URL, email
domains or signing certificates, compared as a SHA-256 fingerprint), is a new activation, applied
once: every person's credentials are revoked (`credentials_revoked_at`),
role evidence is cleared, console sessions are deleted, and live SSH certificates are marked
revoked. Everyone signs in through SSO again, and those new sessions are valid. A restart with
unchanged config does nothing. Switching off is recorded and revokes nothing; roles stay as last
set and admins manage them again. Requests wait until the activation is applied. Machine agent
credentials are not human credentials and are never touched. An IdP certificate rollover is a new
activation too: evidence verified under one set of trust anchors is never carried over to another.

**CLI sign-in codes.** `cloudable login` gets a 60-second code from the console and redeems it for
a CLI token and an SSH certificate. Redemption checks the person and the mode fence when it starts,
and again under database locks after the certificate is signed, so a revocation or activation that
lands in between hands out nothing (and revokes the certificate just stored). The CLI token is
dated by the code's issue time, not the redemption time, so a revocation after the code was
issued refuses the token too, even after a later fresh SSO sign-in.

**What Cloudable refuses.** Role and approver changes from the People page, the API and the CLI
answer 409 `ROLES_MANAGED_BY_IDP`, "Roles are managed by your identity provider." Adding a person
still works, as a member; their first sign-in sets the real role. Email changes, deactivation and
offboarding still work. The bootstrap admin is added as a member: nothing is promoted locally.
Recovery when the IdP is unavailable is server administration: switch the mode off and restart.

**SSH certificates and revocation.** Cloudable cannot revoke an SSH certificate once issued: there
is no key revocation list (KRL) on any machine (see "Revocation" below). What keeps that from
mattering is that, as this repository sets machines up, nothing trusts the Cloudable CA:

- *What the code guarantees.* No machine setup in this repository tells sshd or authorized_keys to
  accept a user CA (`TrustedUserCAKeys`, `cert-authority`, `AuthorizedPrincipalsFile`). The tunnel's
  `ssh` method opens a shell inside the tunnel daemon, behind the control plane's per-request
  checks, not a connection to sshd. `idp-roles/ssh-ca-trust.guard.test.ts` fails if any tracked or
  untracked file under the agent, tunnel daemon, control plane, infra or scripts introduces such
  trust, and has no escape hatch: trusting the CA must ship together with a working KRL.
- *What it assumes about the deployment, and does not verify.* That machines are set up only by
  this code, and nobody adds CA trust by hand or in an image (the CA public key is inside every
  certificate, so it is not secret). That machines take no inbound traffic: this repository's
  Terraform denies all inbound traffic on the machines subnet it creates, but the Azure provisioner
  accepts any `AZURE_MACHINES_SUBNET_ID` and gives each machine a public IP, so a deployment using
  another subnet must enforce this itself. Cloudable does not attest either from the machines.

If those assumptions fail, a certificate issued before a refusal or an activation keeps working
against sshd until it expires: at most 8 hours with the mode off, at most the person's role
deadline with it on. That cap bounds the exposure. It is not revocation, and nothing here relies
on it as such.

**What is recorded.** Every decision writes one of the shared contract's events, with the fields
`service`, `actor`, `subject`, `source`, `previousGrants`, `newGrants` and `reason`, and the same
JSON on a `[security] idp-roles` log line. No tokens or assertion content are recorded.

| Event | When |
| :--- | :--- |
| `idp_roles.granted` | A verified sign-in set new grants. Actor type `idp`. |
| `idp_roles.revalidated` | A verified sign-in confirmed the same grants. |
| `idp_roles.denied` | A sign-in had no mapped role. Credentials ended. |
| `idp_roles.local_change_refused` | A role or approver change in Cloudable was refused. |
| `idp_roles.activation` | The mode was switched on, off, or remapped (one per org). |

`person.role_changed` and `person.approver_changed` are still written alongside, with actor type
`idp`, so existing readers see every change.

**Configuration** (environment of the control-plane container)

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `IDP_ROLES_ENABLED` | `false` | `true` or `false`, exactly. |
| `IDP_ROLE_CLAIM` | none, required when on | The SAML attribute name holding the roles, matched exactly. |
| `IDP_ROLE_MAPPING` | none, required when on | JSON object: claim value to a list of `owner`, `admin`, `member`, `approver`. |
| `IDP_RECHECK_INTERVAL_SECONDS` | `3600` | Whole seconds, 1 to 3600. |

The control plane refuses to start on a bad value, on unknown targets, with the mode on but no IdP
declared in deployment config (`IDP_METADATA_URL`, `IDP_SAML_CONFIG`), or with
`PASSWORD_SIGN_IN=on`. With the mode off, malformed role settings are still refused.

**Moving from older names.** `ROLES_FROM_IDP` and `IDP_ROLE_UNMAPPED` (an earlier, unreleased
version of this mode) are refused, even next to the new names. Replace `ROLES_FROM_IDP=on` with
`IDP_ROLES_ENABLED=true`, set `IDP_ROLE_CLAIM` explicitly (there is no default any more), turn each
mapping value into a list (`"admin"` becomes `["admin"]`), and drop `IDP_ROLE_UNMAPPED`: a sign-in
with no mapped role is always refused.

Any SAML IdP works (Entra ID, Okta, Google Workspace, Keycloak, AD FS): send the roles as one
attribute, single- or multi-valued, and name it in `IDP_ROLE_CLAIM`.

**Example: Entra ID**

1. In the Cloudable enterprise application's app registration, open **App roles** and create one
   role per Cloudable role, for users: for example `Cloudable.Admin`, `Cloudable.Member` and
   `Cloudable.Approver` (the **Value** is what the attribute carries).
2. In the enterprise application, **Users and groups**: assign each person or group a role. A
   person can hold several; assign `Cloudable.Approver` next to a base role.
3. Entra sends assigned app roles as
   `http://schemas.microsoft.com/ws/2008/06/identity/claims/role`. Under **Single sign-on**,
   **Attributes & Claims**, check that no rule removes it. Keep assertion signing on (the Entra
   default).
4. Set on the control plane:

```
IDP_ROLES_ENABLED=true
IDP_ROLE_CLAIM=http://schemas.microsoft.com/ws/2008/06/identity/claims/role
IDP_ROLE_MAPPING={"Cloudable.Admin":["admin"],"Cloudable.Member":["member"],"Cloudable.Approver":["approver"]}
IDP_RECHECK_INTERVAL_SECONDS=3600
```

A person with no Cloudable app role is then refused at sign-in.

### Approvals that replace open paths

- **Package installs** need an approval, by default from one person (`package_install` on the
  Organisation page). The owner asks on their own machine, an admin on any. The install is queued
  only once it is approved. A removal is queued at once.
- **Approval settings** change only with an approver's sign-off. An admin asks
  (`POST /api/v1/organisation/approval-modes`), an approver decides, then the new modes apply.
  This request can never be set to need no one.
- **Restore** goes back to the snapshot's own owner only. Restoring a person's data to someone
  else is refused.

## What the Access surface shows, and nothing else

**"Which certificates are live, for whom, expiring when"** — nothing more. This build
deliberately does not implement, and must not grow, any of: per-key staleness clocks, 90-day
access reviews, password-authentication toggles, per-machine connection passwords, or SSH public
key upload. Certificates replace key upload entirely.

`GET /api/v1/access/certificates` is the entire read surface for this: id, person,
machine scope, fingerprint, issued/expires timestamps, revoked-at/reason. See
`packages/contracts/src/domains/access.ts` for the wire shape.

## 1. SSH CA (`apps/control-plane/src/services/ssh-ca/`)

### Key handling

The CA private key **never enters the control plane's own memory** beyond the `Signer` port
(`apps/control-plane/src/services/Signer.ts`). `SshCaService.ts` calls
exactly two operations against it:

- `signer.publicKey(SSH_CA_KEY_ID)` — to embed the CA's public key in each certificate's
  `signature key` field (`openssh-cert.ts`'s `CertificateFields.caPublicKeyRaw`).
- `signer.sign({ keyId: SSH_CA_KEY_ID, algorithm: "ed25519", data: certificateBody })` — the one
  operation that needs the private key, executed entirely inside the `Signer` implementation
  (`Signer.local.ts` for this build; `Signer.azure.ts` — a stub, no Azure Key Vault account exists
  yet — is where a real deployment would call Key Vault's sign API instead).

No other file in `services/ssh-ca/` or `tunnel/` imports `node:crypto`'s key-generation/export
APIs on a *private* key — `openssh-cert.ts`'s `rawEd25519FromSpki` and `session-token.ts`'s
`crypto.createPublicKey`/`crypto.verify` only ever touch the CA's **public** key bytes, which are
not sensitive.

### Certificate format

`openssh-cert.ts` hand-assembles an OpenSSH `ssh-ed25519-cert-v01@openssh.com` certificate byte
string per the format documented in OpenSSH's `PROTOCOL.certkeys` — there is no library
dependency for this; it is ~150 lines of RFC 4251 §5 primitives (`string`/`uint32`/`uint64`
framing) plus the fixed field layout. `SshCaService.issueCertificate`:

1. Takes `{ orgId, personId, osUser, machineScope, subjectPublicKeyRaw }` — `subjectPublicKeyRaw`
   is the **caller's own ephemeral public key** (32 raw bytes, not SSH-wire-framed), generated
   locally by `cloudable login` and never seen as a private key by the control plane.
2. Builds `CertificateFields`: `certType = 1` (user certificate), **principal = the OS user**
   (`validPrincipals: [osUser]`), **validity ≈ 8h** (`CERTIFICATE_TTL_SECONDS`, with a 60s
   backdate for clock skew), `keyId = "cloudable:<personId>"` (shows up in sshd's auth log —
   ties a certificate-authenticated session back to the person), and **exactly one extension:
   `permit-pty`**.
3. Deliberately omits `permit-port-forwarding` / `permit-agent-forwarding` /
   `permit-X11-forwarding` / `permit-user-rc` (ssh-keygen's usual defaults) — this product brokers
   governed interactive access, not a general tunneling/forwarding facility ("no inbound access...
   tunnels are outbound"; "no general application hosting"). A
   certificate that could also open arbitrary port forwards would be a much larger grant than "an
   interactive shell as this OS user."
4. Serializes the body, signs it via `Signer`, assembles the final blob, and formats it as an
   `authorized_keys`-style line (`formatAsOpenSshLine`).

**Correctness is verified against real OpenSSH, not just self-consistently**:
`openssh-cert.test.ts` writes an assembled certificate to disk and runs the actual `ssh-keygen -L
-f` parser against it, asserting on its output (principal, key ID, serial, validity window, and
that *only* `permit-pty` is present). If the byte layout were wrong, `ssh-keygen` would fail to
parse it or print something else — the test would catch that, not just assert our own encoder
against our own decoder.

### Revocation

`certificates.revokedAt`/`revokedReason` are set by `revokeCertificate`, scoped to the calling
org (a certificate can only be revoked by the org that owns it — see the cross-org test in
`SshCaService.test.ts`). **This is not consulted by sshd at connection time** — OpenSSH would
need a live Key Revocation List (KRL) file on every machine for that, which this build does not
maintain. Revocation here means: the row is marked revoked (audit trail, satisfies the "access
revoked on offboarding" compliance check via `access.certificate_revoked`), and the certificate's
own ~8h TTL is the actual enforcement mechanism — a revoked certificate simply expires within 8
hours regardless. This is a real limitation, not an oversight: closing it fully means shipping and
distributing a KRL to every machine's sshd, out of scope for this build.

`serial` is left at `0` (unspecified) for the same reason — this CA does not track per-certificate
serials for KRL purposes.

### `machineScope` is recorded, not enforced

`issueCertificate` takes a `machineScope` (`"all"`, or a list of machine ids from `cloudable login
--machine-scope`). The handler checks it first: it may name only the person's own machines, and
`"all"` is narrowed to exactly those. It writes the scope to the `certificates` row and puts it in
`access.certificate_issued`, and then builds a certificate that does not mention it. The only principal is the OS user, and
the only extension is `permit-pty`. sshd never learns the scope, so a certificate issued for
`m-abc` authenticates to `m-def` exactly as well.

Nothing is exploitable through this today, because no machine trusts the CA yet: the agent
observes `sshd` (`apps/agent/src/access-methods.ts`) but never configures it, and
`TrustedUserCAKeys` appears nowhere in this repo. Cloudable certificates currently authenticate to
nothing. `cloudable connect` is the live path to a shell, and it is control-plane mediated
(section 4).

What is live is the *claim*. The evidence projection and the schema comment have both been
reworded to say "requested" rather than "scoped", because an auditor reading "scope: m-abc" would
take it as a restriction that held. Do not quietly reword them back when the field starts looking
authoritative — reword them when it *is*.

### Making it real: scope in the principal

This belongs to whoever wires up CA trust on the machine, in the same change, not to a later
bolt-on. The certificate is the wrong place to fix it alone; the two halves only work together.

Issue the scope as the principal rather than the bare OS user:

| `--machine-scope` | `validPrincipals` |
| :-- | :-- |
| `all` | `["cloudable-all:alice"]` |
| `m-abc` | `["m-abc:alice"]` |
| `m-abc,m-def` | `["m-abc:alice", "m-def:alice"]` |

On each machine, the agent writes `/etc/ssh/auth_principals/<osUser>` containing that machine's
own id and the wildcard, one per line:

```
m-abc:alice
cloudable-all:alice
```

with `sshd_config` naming `TrustedUserCAKeys /etc/ssh/cloudable_ca.pub` and
`AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u`.

sshd then matches offline. A certificate whose principals are all for other machines matches
nothing on this one and is refused, with no call to the control plane and no new failure mode when
the control plane is down (invariant 7). Multi-machine scope needs no second certificate, because
a certificate carries a list of principals natively.

Two things to get right when building it:

- **Cap the principal list.** A scope naming hundreds of machines would produce an enormous
  certificate. Reject past a sane bound at issue time rather than emitting something sshd will
  struggle with.
- **The agent rewrites the file, it does not append.** Desired state is edited and live machines
  are not (invariant 10); an append-only principals file would accumulate stale grants that
  nothing ever removes, which is the drift this product exists to catch.

This still does not give per-certificate revocation — that needs a KRL, see above. It gives
*scope*, which is a different property and a cheaper one.

## 2. `cloudable login` (`apps/cli/src/login.ts`)

### One sign-in, two credentials

`cloudable login` is the CLI's only way in. It returns two credentials from a single browser
sign-in, because two different things verify them:

| | Verified by | Lifetime | Revocation |
| :-- | :-- | :-- | :-- |
| SSH certificate | `sshd` on the machine, offline | ~8h | The TTL. Nothing re-checks it once issued. |
| API bearer token | The control plane, on every call | 30d | Immediate. The `people` row is re-read per request. |

The certificate goes into ssh-agent and never touches disk. The token goes to
`~/.cloudable/<host>/session.json` at `0600` and rides `Authorization: Bearer` from there
(`services/CliToken.ts`, `http/middleware/auth.ts`).

There used to be a second command, `cloudable auth login`, which posted an email and password to
BetterAuth's `/api/auth/sign-in/email` and kept the session cookie. It is gone, and not because
two commands were confusing (they were). A CLI that collects a password collects it into argv, so
into shell history and the process table, checks it against whatever host `CLOUDABLE_API_URL`
names, and bypasses SSO completely — an org that had connected SAML could still hand out
passwords and never see it. Password sign-in itself is untouched: it happens at the console's
`/login`, which is where SSO is also offered and which `/cli-auth` already routes through.

The headless case that password flow was really serving is now `CLOUDABLE_TOKEN`, read in place
of the session file. CI gets a credential with no browser and no password.


### The real IdP seam: SAML, not the old dev flags

Build order step 10 is partially here: real login SSO (SAML, via `@better-auth/sso` — see
`apps/control-plane/src/services/IdpSsoService.ts` and `docs/spec.md` §3) is wired; SCIM
provisioning is not — `people.source` still only ever gets set to `"manual"` today.

`cloudable login [--os-user <user>] [--machine-scope all|m1,m2]` opens the system browser to the
console's `/cli-auth` page, which sits behind the ordinary session guard: an unauthenticated visit
detours through `/login` (email/password, or "Sign in with SSO" once an org has connected one) and
back. Once signed in, `/cli-auth` mints a short-lived signed code
(`POST /api/v1/cli-auth/code`, session-gated, `services/CliAuthCode.ts`) and redirects the browser
to a `node:http` server this CLI process is running on an OS-assigned localhost port — the only
thing that ever sees the code. `cloudable login` then calls `issueCertificate` with `{ code, ... }`
instead of a client-asserted `orgId`/`personId`; the control plane verifies the code's signature
and expiry (60s) and derives `{ personId, orgId }` from it, never trusting the request body
directly.

The old `--dev-person-id <id> --org-id <id>` flags are gone, not kept as a fallback: they worked
by having `issueCertificate` trust client-supplied identity directly, which is exactly the hole
`code` closes — reopening it behind a flag would mean reopening it for anyone who passes that flag,
not just local dev. Nothing else in this repo invoked them programmatically. Local/sandbox testing
without a real IdP still works end-to-end: sign up via email/password at `/login`, then run
`cloudable login` — this flow doesn't care which method produced the session.

### What's real: the ephemeral keypair and the certificate

1. `ed25519-keys.ts` generates a **fresh Ed25519 keypair per login** via `node:crypto`, living
   only as long as the certificate does. Node only exposes SPKI/PKCS8 DER for key material;
   `rawPublicKeyFromSpki`/`rawSeedFromPkcs8` extract the raw 32-byte point/seed by slicing a
   fixed-offset header off the DER (Ed25519 SPKI/PKCS8 have no variable parameters — RFC 8410 —
   so the header length is constant). This is verified empirically in `ed25519-keys.test.ts`: the
   extracted seed is used to **rebuild** a PKCS8 key, and the test asserts the rebuilt key derives
   the identical public key and produces signatures that verify against the original — not just
   "the code runs," but "the byte offset is provably correct."
2. Only the **public** half (`publicKeyBase64`) is sent to `POST /api/v1/access/certificates` —
   the private seed never leaves the CLI process.
3. The control plane's SSH CA signs it (the SSH CA section above) and returns the certificate.

### Loading into ssh-agent: wire protocol, not a shell-out

**`ssh-agent-client.ts` implements the `SSH_AUTH_SOCK` agent protocol directly** (RFC 9987 §5.2,
§8 — message framing, `SSH_AGENTC_ADD_IDENTITY`/`SSH_AGENTC_ADD_ID_CONSTRAINED`, the
`SSH_AGENT_CONSTRAIN_LIFETIME` constraint) rather than shelling out to `ssh-add`. This was the
brief's stated preference, and it was tractable here: the message format for a *bare* key is in
the RFC; the format for a **certified** key (cert blob in place of the raw public key, private key
fields unchanged) is an OpenSSH extension not covered by the RFC, confirmed by reading
`openssh-portable`'s `sshkey.c` (`sshkey_private_serialize_opt`) and `ssh-ed25519.c`
(`ssh_ed25519_serialize_private`) source directly.

- The private key is loaded with an `SSH_AGENT_CONSTRAIN_LIFETIME` constraint sized to the
  certificate's remaining TTL, so the agent forgets the ephemeral key on its own once the
  certificate would have expired anyway — no separate cleanup step needed.
- **Verified against a real `ssh-agent` process**, not just self-consistently:
  `ssh-agent-client.test.ts` spawns an actual `ssh-agent -D`, generates a real CA key and signs a
  real certificate via `ssh-keygen -s` (independent of `SshCaService` — a second, independent path
  to a certificate, so the test doesn't just check "our writer agrees with our reader"), sends our
  hand-rolled `ADD_ID_CONSTRAINED` message, and then asks the **real agent** (`ssh-add -L` /
  `ssh-add -l`) to confirm it stored a certificate (not a bare key) and can list it back. It also
  covers two failure paths: a malformed (wrong-length) public key is rejected before the socket is
  even touched, and pointing at a socket with no agent listening fails loudly rather than
  succeeding silently.
- If `SSH_AUTH_SOCK` is unset, `login.ts` still returns the issued certificate and prints a clear
  message rather than failing the whole command — useful for environments (CI, minimal
  containers) with no agent running.

**Tradeoff note**: the brief allowed a pragmatic `ssh-add` shell-out as an acceptable fallback
given time constraints. This build did not need that fallback — the protocol is simple enough,
and a real `ssh-agent` was available in the build/test sandbox to verify against — but if a future
environment's agent behaves differently (e.g. Windows' OpenSSH agent, `gpg-agent` in SSH mode, or
a corporate agent forwarder with different constraint support), falling back to `ssh-add` for that
specific identity file is the documented escape hatch.

## 3. Signed session tokens (`apps/control-plane/src/tunnel/session-token.ts`)

*"The control plane mints a short-lived token carrying IdP identity, target machine
and target OS user, signed via the same Key Vault sign operation as the SSH CA. The agent
validates the signature before attaching."*

- **Format**: `<base64url claims>.<base64url signature>` — deliberately not a full JWT (no extra
  library dependency; the agent's dependency surface is meant to stay thin, and the tunnel daemon
  that will eventually verify these tokens is the agent-side
  counterpart to this file). The signature covers the exact bytes of the claims segment string,
  not a re-serialization of parsed JSON, so verification never has a canonicalization mismatch to
  worry about.
- **Same `Signer` port, a distinct key**: `mintSessionToken`/`verifySessionToken` use
  `SESSION_TOKEN_KEY_ID = "session-token"`, a different `Signer` keyId from
  `SshCaService`'s `SSH_CA_KEY_ID = "ssh-ca"`. *"The same Key Vault sign operation as the
  SSH CA"* is read here as *the same port/mechanism* (both go through `Signer.sign`, never a
  separate ad hoc signing path), not literally the same key — separating the two means a
  session-token compromise cannot also be used to mint SSH certificates, and vice versa.
- **TTL**: 15 minutes (`SESSION_TOKEN_TTL_SECONDS`). This token only authorizes the *handshake* —
  attaching to a session — not the session's duration; a session, once attached, is tracked by its
  own `sessions` row and ended independently.
- **Verification order matters**: `verifySessionToken` checks the signature **before** trusting
  anything about the claims, including expiry — an attacker must not learn "the claims were at
  least well-formed" from a token whose signature doesn't check out. The `keyId` used to fetch the
  verification public key is **fixed** to `SESSION_TOKEN_KEY_ID`, never read from the token itself
  — trusting an attacker-supplied key identifier to pick which key to verify against is a classic
  signature/key-confusion bug class.
- **Verification is local, not routed through `Signer` again**: `Signer.publicKey()` returns the
  CA's public key bytes once; `crypto.verify` runs against those bytes directly. This mirrors how
  a real KMS/HSM works — only signing needs the vault, anyone holding the public key can verify —
  and keeps `Signer`'s surface exactly `{ sign, publicKey }`, unchanged from the port this unit was
  handed.

### Required failure-path test

*"An agent skipping signature validation attaches
sessions fine [...] a session token with a broken signature must be refused"* —
`session-token.test.ts` includes, and passes:

- A token with a **tampered signature** (valid claims, valid expiry, one bit flipped in the
  signature) is refused with `reason: "invalid_signature"`.
- A token with **tampered claims but the original signature** (simulating a
  `targetOsUser: "ubuntu"` → `"root"` privilege-escalation rewrite) is refused the same way — the
  signature covers the claims bytes, so any edit invalidates it.
- A **validly signed but expired** token is refused with `reason: "expired"`, and only after the
  signature check passes (proving the ordering above).
- A malformed token (no `.` separator) is refused with `reason: "malformed"`.

This is the test that must exist and pass before anything downstream (the tunnel daemon, the web
terminal) can be trusted to gate on this token at all.

## 4. Web terminal / tunnel daemon — control-plane side (`apps/control-plane/src/tunnel/server.ts`)

### What's real

- **`mintSession`** — the one real policy gate this build has for session access: it looks up the
  target machine and **denies** (emitting `access.session_denied` with a reason —
  `machine_not_found` or `machine_<state>`) any request against a machine that isn't `running`. An
  archived or stopped machine has no live tunnel daemon connection to attach a session to, so
  minting a token for it would be a token nobody could ever redeem — denying it up front, with an
  audited reason, is more honest than minting a token that would silently never work.
- On success: mints a session token (see the signed session tokens section above), inserts a `sessions` row (`method`, `osUser`,
  `startedAt`), and emits `access.session_started`.
- **`endSession`** — marks a `sessions` row ended, computes `durationSeconds`, emits
  `access.session_ended`. Refuses (`reason: "not_found"`) if the session is already ended or
  doesn't belong to the calling org.
- **`terminateSessionsForMachine(machineId, reason)`** — the *"disabling terminates live
  sessions"* path. Ends every still-open session against a machine in one call and
  emits `access.session_ended` for each. This is real and tested
  (`server.test.ts`) independent of whether anything is actually listening on the other end of a
  tunnel — a future feature unit (whichever wires "disable access" into machine/policy settings)
  calls this function; the termination *logic* doesn't wait on the transport.
  - `reason` is accepted and available to the caller for logging, but is **not** persisted as its
    own column or event field — neither the (already-built, out of this unit's scope)
    `sessions` table nor the `access.session_ended` event payload carry a termination-reason
    field. Adding one would mean modifying `packages/schema`/`packages/events`, both explicitly
    handed to this unit as complete. Documented here as a known gap rather than worked around by
    quietly changing frozen files.
- **The tunnel-signal channel** (`tunnel/signal.ts`, see `docs/agents.md`'s own section on it for
  the full design/agent-side half): `mintSession`, `endSession`, and `terminateSessionsForMachine`
  all now push to it — `{type: "session_waiting", sessionId}` on a successful mint,
  `{type: "session_terminate", sessionId}` for every session `endSession`/`terminateSessionsForMachine`
  ends. This is the piece that makes any of the three actually reach a *connected* agent, not just
  flip a database row — the first real (if minimal) slice of the CP → agent half of the transport
  described as fully stubbed below.

### The reverse-tunnel transport — real now, not this unit's original scope

**An earlier version of this section described the reverse-tunnel byte-relay transport as still
not implemented**, matching the cross-unit brief this unit was built against: *"the actual
reverse-tunnel network transport can be a documented stub/simplification if time is tight [...]
the SIGNATURE VALIDATION logic is what must be real and tested, the transport mechanics are
secondary."* That's since been built for real, as its own separate binary:
`apps/tunnel-daemon` (its own persistent outbound connection, `connection.ts`, and a real
per-session PTY multiplexer, `session-manager.ts`) — not `apps/agent`, and not the manual,
dev-only trigger `apps/agent/src/tunnel/client.ts` used to provide (removed; it was never wired
into the real signal-driven attach path, only reachable via an explicit env-var escape hatch).

`session-manager.ts`'s `attach` verifies the session token — the same real signature check this
doc's earlier sections describe — before ever spawning a PTY, on every attach including a
reconnect, not just the first one. `pty.ts` then drops privilege to the session's `targetOsUser`
via `su`.

**`targetOsUser` is no longer the caller's to choose.** It used to be a request field, validated
only against a username-shaped regex — which `"root"` passes. The console's own terminal dialog
sent exactly that, so every web terminal session in the product was a root shell on a machine
whose entire model is one unprivileged user. It also meant an admin holding a `shell` elevation
against someone else's machine silently got root, which is more than that grant describes.

`mintSession` now sets it to `MACHINE_OS_USER` (`packages/contracts`), the same constant the
provisioner uses for `osProfile.adminUsername`, and the field is gone from the wire. The daemon's
own username-shape check stays as defence-in-depth against an argv-injection vector into `su`,
rather than being the only thing standing between a caller and an arbitrary account.

This removes the class rather than validating around it, and it costs no capability: `cloudable`
is the Azure admin user and holds passwordless sudo, so root remains one `sudo` away — as a
logged action inside a session, rather than the session itself.

### One replica, and why that is a constraint rather than a size

`tunnel/registry.ts` holds live connections in an in-process `Map`. A machine's tunnel daemon
opens one outbound websocket to whichever control-plane instance answers; an attach request
load-balances independently. If the two land on different instances, the attach finds no daemon
for that machine and times out after 15s, and the CLI reports that the daemon may not be
connected — which is true of *that instance*, and false of the machine.

This is not theoretical. A real deployment ran with `max_replicas = 3`, and connecting worked
roughly one attempt in three, interleaved with `connection_lost` and attach timeouts. It reads
exactly like a flaky machine, which is the wrong place to go looking.

`max_replicas` therefore defaults to 1, and the variable says why. Lifting it requires sharing the
registry across instances first — pub/sub, or Postgres `LISTEN`/`NOTIFY` — not just more capacity.

### TLS terminates at the control plane, by construction

*"Browser TLS terminates at the control plane by construction — end-to-end
encryption to the machine is not available on this path at any logging tier."* This is not a
configuration flag anywhere in this build — it falls directly out of the shape of the design: the
browser's terminal talks HTTPS to the control plane's own domain (there is no public endpoint on
any machine to connect to instead), so the control plane is unavoidably an
intermediary that sees the (decrypted) session bytes, regardless of what logging tier is
configured. Logging records session start, end and denial; it does not record the commands run
inside a session.

## 4b. File sessions (`method: "files"`)

The consumer of `elevations.level = "file_recovery"`. That level has existed since the
elevation unit landed, with a passing test asserting it cannot open a shell — and until this,
nothing in the product let anyone actually recover a file with it, so the lower of the two
levels was unreachable.

`docs/spec.md` §15 orders the two deliberately: file recovery is lower risk, interactive shell
higher, because a shell can read injected secrets on a live machine.
`domain/elevation/policy.ts` charges a lower approval floor for file recovery on that basis.
Everything below exists to keep that ordering true in practice rather than only on paper.

### It is a session, not a page

A file session goes through the same path a terminal does: `POST /api/v1/access/sessions` with
`method: "files"`, the same signed token, the same `sessions` row, the same tunnel signal, the
same `GET /api/v1/access/sessions/:id/attach` websocket. It appears on the Access page, can be
terminated, and is closed by `closeSessionsWithLapsedAuthorization` when the elevation behind
it lapses.

Three things followed for free, and all three are load-bearing:

- `sessions.method` is plain `text` with no check constraint, so `"files"` needed **no
  migration**.
- `accessMethodsEnabled` is JSON resolved against a code default, so adding its `files` key
  needed **no migration** and no backfill — a value stored before the key existed simply falls
  back to the default.
- `access.session_started` / `session_ended` / `session_denied` already carried `method` in
  their payload, so this added **no new event type**. The catalogue snapshot is unchanged,
  which is the check that proves it (invariant 11).

### Audit: the session, not the file

A files session is recorded exactly like a terminal one — start, end, denial, with `method`
in the payload — and nothing is emitted per file read or written.

That is a deliberate choice, not a gap. The same edit made with `vi` in the web terminal emits
nothing, so a per-write event here would produce a record that *looks* complete to an auditor
and is not: it would cover only the edits that happened to go through this interface. A
partial trail presented as a whole one is worse than an honest session-level trail. Per-operation
capture does not exist for either surface. If it is ever built it should cover both at once.

### Authorization is per-method

`isAuthorizedForInteractiveAccess` (`tunnel/access-authorization.ts`) takes the session method
and consults `ACCEPTED_ELEVATION_LEVELS`:

| Method | Satisfied by |
| :--- | :--- |
| `terminal`, `ssh` | `shell` |
| `files` | `file_recovery` **or** `shell` |

`shell` dominates — someone trusted with a shell is already trusted with the files. The reverse
must never hold, or the cheaper approval floor becomes a route to the dearer one.

**The parameter is required and has no default, on purpose.** There are two callers: the
mint-time gate, and the steady-state re-authorization sweep. The sweep re-checks every open
session on a timer, so if it asked the terminal question about a files session, every file
session held on a `file_recovery` grant would be closed on the next tick — minted successfully,
then killed seconds later with `policy_terminated` and no visible cause, and only for the
non-owner case elevation exists to serve. `closeSessionsWithLapsedAuthorization` selects
`sessions.method` and passes it through for exactly this reason.

### Termination is per-method too

`webTerminal` and `files` are separately disablable, so "disabling terminates live sessions"
has to mean disabling *that* method terminates *that* method's sessions.
`terminateSessionsForMachine` takes an optional `methods` filter, and
`domain/config/apply-setting-change.ts` compares both flags and terminates each affected set
with its own reason. Whole-machine events (archive, restart, offboarding) pass no filter and
still close everything.

⚠️ **Known gap, pre-existing.** That path calls `TunnelServer` rather than `TunnelRelay`, so
it updates `sessions` rows and emits `access.session_ended` but never tears down the live
websocket relay — the PTY or `su` helper keeps running and the browser stays connected. So
"disabling terminates live sessions" is currently true of the record and not the connection,
for `webTerminal` just as much as `files`. The method filter makes that operation precise
about which sessions it ends; it does not make it reach the transport. Closing it needs
`terminateSessionsForMachine` to return the ids it ended so the relay can close exactly
those — `TunnelRegistry.closeAllForMachine` keys on machine id alone and would otherwise
drop every socket on the machine. See `tunnel/relay.ts`'s own note.

### The privilege drop is the security property

The tunnel daemon runs as root, because `pty.ts` needs root to `su` into an arbitrary OS user.
If file operations ran in the daemon process they would run **as root**, and a `file_recovery`
elevation would then grant strictly more than a `shell` one: readable `/etc/shadow`, readable
secret material a `cloudable` shell on the same machine cannot touch. That inverts the ordering
the whole feature rests on and makes the cheaper approval the dangerous one.

So operations run in a separate unprivileged process. `files-session.ts` spawns
`su - <osUser> -c '<self> --fs-helper'`, re-executing the daemon's own compiled binary — one
artifact, one install path, no way for the two halves to be at different versions. The helper
(`fs-helper.ts`) speaks newline-delimited JSON on stdio and calls plain `node:fs/promises`;
every success and failure is the OS's decision against the uid it was dropped to.

`index.ts` is a thin argv dispatcher with *dynamic* imports for both branches. A static import
of the daemon's startup path would attest and open a tunnel merely by loading the entrypoint,
and the helper has no credentials to attest with — `su -` resets the environment, so
`CONTROL_PLANE_URL` and `MACHINE_TOKEN` are gone by the time it runs.

There is **no path allowlist and no chroot**, also deliberately. File recovery legitimately
reaches `/etc` and `/var/log`, and a restriction the web terminal does not share would be
theatre rather than security. The OS permission model is the boundary, exactly as it is for a
shell.

### The token decides the kind, never the frame

`session-manager.ts` branches on `claims.method` from the *verified* token, not on anything in
the `attach` frame. A token minted for `"files"` cannot be made to spawn a PTY by rewriting the
frame, because the frame is not consulted. Behind that, file and PTY sessions live in separate
maps keyed by the same id, so an `fs_request` naming a live terminal session finds nothing to
run against.

### Wire and limits

Three frames on the existing envelope: `fs_request`, `fs_response`, and `fs_chunk` (downloads
and uploads, 64 KiB each). `requestId` correlates within a session; `sessionId` stays the
session-level key both `isTunnelFrame` guards require, and the attach route forces it to its own
path param regardless of what a frame claims.

| Limit | Value | Why |
| :--- | :--- | :--- |
| Inline read/edit | 1 MiB | Held as a base64 string in a browser tab |
| Download/upload | 50 MiB | |
| Directory listing | 10,000 entries | Then `truncated`, rather than one enormous frame |

Reads also refuse anything containing a NUL byte (`is_binary`): the editor round-trips content
through a JavaScript string, so a non-text file would come back subtly different from what went
in. It is still downloadable.

Operations are `list`, `read`, `write`, `mkdir`, `rename`, `download`, `upload`. **No delete and
no chmod** — neither is needed to recover or fix a file, and both are easy to fire by accident
through a pointer interface. Because there is no delete, the two operations that could clobber
something are guarded: `rename` refuses an existing destination, and `upload` refuses one unless
`replace` was explicitly set. A save pins `expectedModifiedAt` to what was read and fails with
`changed_on_disk` if anyone else touched the file meanwhile, rather than silently discarding
their work.

Failures are a fixed reason vocabulary and never carry the raw errno string, which would echo
paths and internals into a browser and the control plane's logs — the same rule
`AttestationError` follows for credentials.

## 4c. Snapshot inspection (`method: "snapshot_files"`) — a session with no machine

`docs/lifecycle.md` owns this; what belongs here is why it is a `sessions` row at all when
nothing in this document's machinery touches it.

It never reaches a tunnel daemon. The control plane reads the archived machine's disk
snapshot itself, so there is no PTY, no `su`, no privilege drop, no attach websocket and
**no session token** — nothing downstream would verify one. `SessionMethod` in
`tunnel/session-token.ts` deliberately stays `terminal | ssh | files`: a method the daemon
must never spawn should not appear in the type that says which methods it may.
`SessionRowMethod` in `@cloudable/contracts` is the wider set a `sessions` ROW can hold,
and code reading a row generically branches on `"snapshot_files"` first and narrows after.

It is still a session row, because everything that makes access governable is keyed off
that table rather than off the transport: it appears on the Access page, it can be
terminated, `closeSessionsWithLapsedAuthorization` re-checks it (dispatching to its own
gate — see below), and it emits `access.session_started` / `_ended` / `_denied` with
`method: "snapshot_files"`.

**Do not reuse `isAuthorizedForInteractiveAccess` for it.** That function treats a null
owner as "allow anyone in the org", which is right for a machine mid-provisioning and wrong
for an offboarded one — and every snapshot offboarding produces belongs to a machine with a
null owner. `domain/archive/inspect-authorization.ts` is the gate, and
`docs/lifecycle.md` has the full reasoning.

## 5. HTTP surface (`apps/control-plane/src/http/routes/access.ts` + `handlers/access.ts`)

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `POST` | `/api/v1/access/certificates` | Issue a certificate (`cloudable login`'s call) |
| `GET` | `/api/v1/access/certificates` | The Access surface's read view (see above). Own only, unless admin |
| `POST` | `/api/v1/access/certificates/revoke` | Revoke a certificate. Own only, unless admin |
| `POST` | `/api/v1/access/sessions` | Mint a session (web terminal / file session / SSH session start) |
| `POST` | `/api/v1/access/sessions/end` | End a session. Own only, unless admin |
| `GET` | `/api/v1/access/sessions` | Open sessions. Own only, unless admin |

Not part of this group (bearer-authenticated like the agent protocol, not `orgId`/`personId`-in-body like the table above) — `GET /api/v1/tunnel/signal`, the tunnel-signal long poll, `apps/control-plane/src/http/routes/tunnel-signal.ts` + `handlers/tunnel-signal.ts`. See `docs/agents.md`'s own section on it.

Every endpoint takes the caller from their session (`CurrentUserTag`), never from the body. A
member sees and ends only their own sessions and revokes only their own certificates; an admin can
do it for anyone in the org. Another person's session or certificate answers 404.

Every endpoint shares one error shape (`{ code, message }`) with four variants —
`not_found` (404), `denied` (403), `bad_request` (400), `internal_error` (500) — mapped from the
tagged domain errors (`SshCaError`, `TunnelError`) each service raises.

## 6. Testing notes

- **Testcontainers timed out in this sandbox** (`apps/control-plane/test/testcontainers.ts`,
  already built by an earlier unit, exists precisely for this purpose but is annotated "Docker
  may or may not be available in every sandbox"). Rather than skip DB-backed tests entirely, this
  unit's tests run against the **local dev Postgres** (`docker-compose.yml`, port 5442 — the same
  instance `bun run dev` uses), scoping every row they write to a fresh random `orgId`/`personId`
  per test so runs never collide with each other or with manual dev-DB use. See
  `SshCaService.test.ts` and `tunnel/server.test.ts`.
- **Effect `Layer.provide` vs `Layer.provideMerge`**: a real pitfall hit while wiring
  `SshCaService`/`TunnelServer` into `layers.ts` — both services' public methods call
  `Signer`/`EventBus` lazily (i.e. when a caller later invokes `mintSession`/`issueCertificate`,
  not only while the service's own constructor effect runs once at layer-build time). Composing
  their dependencies with `Layer.provide` type-checks cleanly but fails at runtime (`Service not
  found: Signer`), because `Layer.provide` satisfies a layer's construction-time requirements and
  then **hides** the dependency's output from anything built on top. `Layer.provideMerge` keeps
  `Db`/`EventBus`/`Signer` present in the final merged context alongside the services themselves,
  which is what a method invoked later, elsewhere in the same program, needs to see. See the
  comment in `apps/control-plane/src/layers.ts` and the two service test files.

## Permission-grant log export

After `EventBus.publish` successfully appends an event, the control plane writes one
JSON line to stdout for an admin/owner role change, an approver grant, or creation
or reactivation of a privileged person through the people API. With roles from the
identity provider on, a sign-in that grants admin/owner or the approver flag is
exported the same way once its transaction commits, with `actorType: "idp"` and the
provider ID as `actorId`. These tier-1 events
are always retained regardless of the configured logging tier.

Records have `source: "cloudable"`, `type: "security"`, `schemaVersion: 1`,
`outcome: "success"`, the event name and persisted event ID, organization ID, actor
ID/type, target person ID, timestamps, and the relevant previous/current privilege
fields under `detail`. Existing event names stay unchanged; person payload fields
are additive and optional for compatibility with old records. The stdout export
uses an explicit allowlist: no email, credentials, or complete event payload.

Deployments can route these records to their log collector and alert per `eventId`.
Duplicate delivery can be deduplicated by that ID. Forwarding is best effort: a crash
between the database append and stdout write can lose the forwarded copy. The
append-only database event log remains authoritative. This is not an outbox or a
retroactive export. Other direct transactional event inserts do not use this exporter.
