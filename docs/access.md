# Access

How access methods are implemented: the SSH CA, `cloudable login`, signed
session tokens, and the web terminal / tunnel daemon's control-plane side.

## What the Access surface shows, and nothing else

**"Which certificates are live, for whom, expiring when"** — nothing more. This build
deliberately does not implement, and must not grow, any of: per-key staleness clocks, 90-day
access reviews, password-authentication toggles, per-machine connection passwords, or SSH public
key upload. Certificates replace key upload entirely.

`GET /api/v1/access/certificates?orgId=...` is the entire read surface for this: id, person,
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
--machine-scope`), writes it to the `certificates` row and puts it in `access.certificate_issued`
— and then builds a certificate that does not mention it. The only principal is the OS user, and
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
configured. Tier 1/2 logging tiers are honest specifically *because* the tunnel passes the
session's TLS through rather than re-encrypting; tier 3 (full command capture) is the tier whose
sold consequence is "Cloudable is on the plaintext path" — this is the same
structural fact stated two ways, not two different claims to keep consistent by hand.

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
capture belongs with `access.command_recorded` (tier 3, its own table, deliberately outside the
catalogue) if and when that is built, and should cover both surfaces at once.

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

## 5. HTTP surface (`apps/control-plane/src/http/routes/access.ts` + `handlers/access.ts`)

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `POST` | `/api/v1/access/certificates` | Issue a certificate (`cloudable login`'s call) |
| `GET` | `/api/v1/access/certificates?orgId=...` | The Access surface's read view (see above) |
| `POST` | `/api/v1/access/certificates/revoke` | Revoke a certificate (org-scoped) |
| `POST` | `/api/v1/access/sessions` | Mint a session (web terminal / file session / SSH session start) |
| `POST` | `/api/v1/access/sessions/end` | End a session |

Not part of this group (bearer-authenticated like the agent protocol, not `orgId`/`personId`-in-body like the table above) — `GET /api/v1/tunnel/signal`, the tunnel-signal long poll, `apps/control-plane/src/http/routes/tunnel-signal.ts` + `handlers/tunnel-signal.ts`. See `docs/agents.md`'s own section on it.

**No path parameters** — certificate/session ids travel in the JSON body rather than `/:id`
segments. This is a deliberate simplification: no `CurrentUserTag` auth middleware exists yet
(`apps/control-plane/src/http/middleware/auth.ts` is an explicit stub — "no endpoint currently
requires `CurrentUserTag`"), so there is no authenticated caller to scope a `/:id` lookup to in
the first place; every request here also carries `orgId`/`personId` explicitly in the body for
the same reason. A future feature unit that wires real auth up should both add `:id` path params
back and drop the body-carried identity fields in favor of the authenticated session — the
`orgId`-scoping already present in every DB query is what that unit will lean on.

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
