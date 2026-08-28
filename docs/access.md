# Access

Implementation detail for spec §11 (Access methods): the SSH CA, `cloudable login`, signed
session tokens, and the web terminal / tunnel daemon's control-plane side. Read `docs/spec.md`
§11 first for the *why*; this file is the *how*.

## What the Access surface shows, and nothing else

Per spec: **"which certificates are live, for whom, expiring when"** — nothing more. This build
deliberately does not implement, and must not grow, any of: per-key staleness clocks, 90-day
access reviews, password-authentication toggles, per-machine connection passwords, or SSH public
key upload. Certificates replace key upload entirely (`docs/spec.md` §11.2, §21).

`GET /api/v1/access/certificates?orgId=...` is the entire read surface for this: id, person,
machine scope, fingerprint, issued/expires timestamps, revoked-at/reason. See
`packages/contracts/src/domains/access.ts` for the wire shape.

## 1. SSH CA (`apps/control-plane/src/services/ssh-ca/`)

### Key handling

The CA private key **never enters the control plane's own memory** beyond the `Signer` port
(`apps/control-plane/src/services/Signer.ts`, CLAUDE.md invariant #9). `SshCaService.ts` calls
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
   governed interactive access, not a general tunneling/forwarding facility (CLAUDE.md invariant
   #7, "no inbound access... tunnels are outbound"; "no general application hosting", §21). A
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

## 2. `cloudable login` (`apps/cli/src/login.ts`)

### The dev-mode IdP seam

There is no real IdP integration in this sandbox (build order step 10, not reached by this
batch). `cloudable login --dev-person-id <id> --org-id <id> [--os-user <user>]
[--machine-scope all|m1,m2]` stands in for "browser → IdP → identity" — clearly gated (the command
refuses to run without both flags) and documented here as **dev-only**. A future feature unit
wires a real OIDC redirect and replaces the two flags with values read from the resulting session;
everything downstream of "we now know `{ personId, orgId }`" is unchanged.

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
3. The control plane's SSH CA signs it (§1 above) and returns the certificate.

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

Spec §11.1: *"The control plane mints a short-lived token carrying IdP identity, target machine
and target OS user, signed via the same Key Vault sign operation as the SSH CA. The agent
validates the signature before attaching."*

- **Format**: `<base64url claims>.<base64url signature>` — deliberately not a full JWT (no extra
  library dependency; the agent's dependency surface is meant to stay thin per `docs/spec.md`
  §25, and the tunnel daemon that will eventually verify these tokens is the agent-side
  counterpart to this file). The signature covers the exact bytes of the claims segment string,
  not a re-serialization of parsed JSON, so verification never has a canonicalization mismatch to
  worry about.
- **Same `Signer` port, a distinct key**: `mintSessionToken`/`verifySessionToken` use
  `SESSION_TOKEN_KEY_ID = "session-token"`, a different `Signer` keyId from
  `SshCaService`'s `SSH_CA_KEY_ID = "ssh-ca"`. Spec's *"the same Key Vault sign operation as the
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

Per `docs/spec.md` §25's explicit requirement — *"an agent skipping signature validation attaches
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
- On success: mints a session token (§3), inserts a `sessions` row (`method`, `osUser`,
  `startedAt`), and emits `access.session_started`.
- **`endSession`** — marks a `sessions` row ended, computes `durationSeconds`, emits
  `access.session_ended`. Refuses (`reason: "not_found"`) if the session is already ended or
  doesn't belong to the calling org.
- **`terminateSessionsForMachine(machineId, reason)`** — the *"disabling terminates live
  sessions"* path (spec §11.1). Ends every still-open session against a machine in one call and
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

### What's stubbed, and why that's acceptable for this batch

**The actual reverse-tunnel network transport is not implemented.** There is no code here that
opens an outbound connection from a machine, multiplexes bytes for an interactive session, or
relays a browser's terminal keystrokes anywhere — `tunnel/server.ts` is described in its own file
banner as "the control-plane side of session brokering," full stop. This matches the cross-unit
brief precisely: *"the actual reverse-tunnel network transport can be a documented
stub/simplification if time is tight [...] since there's no real fleet of machines to tunnel to
[...] the SIGNATURE VALIDATION logic is what must be real and tested, the transport mechanics are
secondary."* Token minting, verification, the policy gate, and the session lifecycle (`sessions`
rows + events) are all real and tested against a real local Postgres (§5); wiring an actual
tunnel daemon process into `apps/agent` and a byte-relay protocol is future work for whichever
unit builds the agent's tunnel half.

### TLS terminates at the control plane, by construction

Per spec §11.1: *"Browser TLS terminates at the control plane by construction — end-to-end
encryption to the machine is not available on this path at any logging tier."* This is not a
configuration flag anywhere in this build — it falls directly out of the shape of the design: the
browser's terminal talks HTTPS to the control plane's own domain (there is no public endpoint on
any machine to connect to instead — invariant #7), so the control plane is unavoidably an
intermediary that sees the (decrypted) session bytes, regardless of what logging tier is
configured. Tier 1/2 logging tiers are honest specifically *because* the tunnel passes the
session's TLS through rather than re-encrypting; tier 3 (full command capture) is the tier whose
sold consequence is "Cloudable is on the plaintext path" (`docs/spec.md` §17) — this is the same
structural fact stated two ways, not two different claims to keep consistent by hand.

## 5. HTTP surface (`apps/control-plane/src/http/routes/access.ts` + `handlers/access.ts`)

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `POST` | `/api/v1/access/certificates` | Issue a certificate (`cloudable login`'s call) |
| `GET` | `/api/v1/access/certificates?orgId=...` | The Access surface's read view (§ above) |
| `POST` | `/api/v1/access/certificates/revoke` | Revoke a certificate (org-scoped) |
| `POST` | `/api/v1/access/sessions` | Mint a session (web terminal / SSH session start) |
| `POST` | `/api/v1/access/sessions/end` | End a session |

**No path parameters** — certificate/session ids travel in the JSON body rather than `/:id`
segments. This is a deliberate simplification: no `CurrentUserTag` auth middleware exists yet
(`apps/control-plane/src/http/middleware/auth.ts` is an explicit stub — "no endpoint currently
requires `CurrentUserTag`"), so there is no authenticated caller to scope a `/:id` lookup to in
the first place; every request here also carries `orgId`/`personId` explicitly in the body for
the same reason. A future feature unit that wires real auth up should both add `:id` path params
back and drop the body-carried identity fields in favor of the authenticated session — the
`orgId`-scoping already present in every DB query (§1, §4) is what that unit will lean on.

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
