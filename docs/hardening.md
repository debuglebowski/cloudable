# Machine hardening

What a new machine comes up with, what it deliberately does not do, and where an auditor
finds the evidence. Code: `apps/control-plane/src/services/hardening.ts`.

## What this is

Every new Azure machine runs a security baseline on its first boot: a subset of the **CIS
Ubuntu Linux Benchmark, Level 1 (Server)**. Controls are named by title below, not by section
number, because numbering differs between the 22.04 and 24.04 benchmark versions.

- **New machines only.** cloud-init runs once per instance. An existing machine is never
  changed (a machine changes only through an explicit, audited action), and a reboot does not
  re-run it. A reimage or a restore builds a new instance, so it applies the baseline again.
- **No custom image.** There is no image pipeline. The baseline is applied by the same
  cloud-init script that already sets up `/home` and the agent, on the stock Canonical image.
- **Nothing is installed or removed.** The baseline only changes settings. It does not add or
  uninstall a package.
- **All or nothing, and visible.** The script reads every setting back before it records
  success. If anything fails, the machine still boots (so it stays visible and can be
  reimaged) but carries no baseline, and the evidence says so.

### The baseline label

When the script succeeds it writes `/etc/cloudable/hardening.json`:

```json
{"baseline":"cis-ubuntu-l1-v1","appliedAt":"2026-01-01T00:00:00Z","exceptions":["ip-forwarding", "..."]}
```

`cis-ubuntu-l1-v1` is the label of the control list this build applies. It changes only when
the list does. The agent reads the label and reports it like any other observed state; the
control plane stores it and prints it in the asset inventory export as `hardening_baseline`.
A machine with no stamp (it predates the baseline, or the baseline failed) reads `none`.

The baseline script is also left on the machine at `/usr/local/sbin/cloudable-harden`, so what
ran can be read, not just claimed.

## What is applied

| Area | Applied |
| :--- | :--- |
| Kernel modules | `cramfs`, `freevxfs`, `hfs`, `hfsplus`, `jffs2`, `usb-storage` cannot be loaded |
| Network | No redirects sent or accepted, no source routing, martian packets logged, reverse-path filtering, SYN cookies, broadcast and bogus ICMP ignored (IPv4, and IPv6 where present) |
| Kernel | Address space randomization on, ptrace restricted where the kernel supports it, setuid programs cannot dump core |
| sshd | No root login, no password or keyboard-interactive login, no empty passwords, no host-based auth, no `.rhosts`, no user environment, no X11 forwarding, 4 attempts, 60 s grace, idle connections probed |
| sudo | Commands run in a pty and are logged to `/var/log/sudo.log` |
| Permissions | `/etc/passwd` and `/etc/group` 644, `/etc/shadow` and `/etc/gshadow` 640 `root:shadow`, cron files and directories root-only |
| Login banner | `/etc/issue` and `/etc/issue.net` carry no OS or version detail |
| Logging | The journal is persistent |
| Services | A short list of server daemons (print, directory, DHCP, DNS, FTP, web, mail, file-share, SNMP, NFS and similar) is disabled and masked if the image ships one. The stock images ship none |

The sshd settings are a drop-in that sorts before the cloud image's own file. Certificate
trust (`TrustedUserCAKeys`) is not touched here; see `docs/access.md`.

## Documented exceptions

Settings Level 1 asks for that this build does not apply, because they would break a
developer's tools. The ids below are written into the stamp file. A test fails if this table
and `HARDENING_EXCEPTIONS` drift apart.

| Id | Control | What this build does | Why |
| :--- | :--- | :--- | :--- |
| `ip-forwarding` | IP forwarding is disabled | Left at the distro default, which Docker overrides when it starts | Container networking needs the kernel to forward packets |
| `udf-module` | udf kernel module is not available | The module stays loadable | Azure can hand the provisioning agent its first-boot data on a UDF volume |
| `squashfs-module` | squashfs kernel module is not available | The module stays loadable | Snap packages and many container tools are squashfs images |
| `core-dumps` | Core dump storage is disabled | Core dumps for ordinary processes stay on; only setuid programs are barred | Developers debug crashes from core files |
| `tmp-mount-options` | `/tmp` is a separate partition mounted nodev, nosuid, noexec | `/tmp` stays on the root filesystem with default options | Compilers, package builds and test runners execute files from `/tmp` |
| `passwordless-sudo` | sudo requires authentication | The OS user keeps passwordless sudo | No machine account has a password; sign-in is by short-lived certificate |
| `password-policy` | Password complexity and aging | Not configured | There is no password to govern, and aging on a locked account can block certificate sign-in |
| `cron-restriction` | cron and at are restricted to authorized users | The machine's user may schedule jobs | Scheduled jobs are an ordinary part of working on one's own machine |
| `default-umask` | Default umask is 027 or stricter | Distro default kept | One person owns each machine; a stricter umask breaks files shared with containers and service users |
| `bootloader-password` | Bootloader password is set | Not set | There is no physical console; serial console access is governed by Azure RBAC |
| `automatic-updates` | Updates and patches are installed | The distro's own automatic security updates are left as shipped; Cloudable does not manage patching yet | Patching should follow the operator's remediation deadlines through an operator-triggered action, which does not exist yet |

## Optional malware protection

Off by default. An organisation turns it on with the org setting
`security.malwareProtection` set to `defender`. Any other value, or no value, means none.

- **Where it is set.** The ordinary settings endpoint, `PATCH /api/v1/config/settings`, with
  `scopeType: "org"`. The change is an `org.setting_changed` event, so who turned protection
  on, and when, is in the audit trail. There is no per-machine override: one machine cannot opt
  out of what the organisation decided.
- **What it does.** When a machine is created, reimaged or restored, Cloudable installs the
  Microsoft Defender for Endpoint Linux VM extension (`MDE.Linux`) itself, as a step of that
  audited action. If the install fails, the whole action fails; an organisation that asked for
  protection does not end up with an unprotected machine that looks healthy.
- **Existing machines are not changed.** The setting is read when a machine is built. Turning
  it on does not touch a machine that is already running.
- **Turn off the provider's own install.** The cloud provider can install the same agent
  automatically for every machine in a subscription. That bypasses Cloudable's audit trail, so
  it should be switched off, with the Defender for Servers plan left on if the organisation
  uses it. That is subscription configuration and lives in the deploy repository's Terraform,
  not here.
- **Azure permission.** The control plane's machine role needs
  `Microsoft.Compute/virtualMachines/extensions/read` and `.../write`. They are in
  `infra/terraform/control-plane/main.tf`, but CI cannot write role definitions: apply the change
  by hand as an Owner, then allow about 30 minutes for it to propagate. Without it the install
  fails and, with protection on, so does every create.

**Not yet verified live.** The extension's publisher and type are confirmed, but its public
settings (`azureResourceId`, `forceReOnboarding`, `vNextEnabled`) were written from Microsoft's
published behaviour and have not been run against a real subscription from this repository.
Check the first live install before relying on it.

Cloudable does not read protection health back. Whether the agent is running and reporting is
visible in the Defender portal, not in Cloudable.

## Evidence

| Control | Evidence source | How to export |
| :--- | :--- | :--- |
| Baseline applied to a machine | `hardening_baseline` column: the label the machine's own stamp file reported at its last check-in, `none` if absent | `cloudable export asset-inventory`, or `GET /api/v1/compliance/exports/asset-inventory.csv` |
| What the baseline contains | This page, `HARDENING_EXCEPTIONS` and `hardening.ts` in the repository at the version deployed; on the machine, `/usr/local/sbin/cloudable-harden` and `/etc/cloudable/hardening.json` | Repository at the deployed commit; the machine's file browser |
| Deviations from the benchmark | The exceptions table above; the stamp file lists the ids that applied | This page |
| Who turned malware protection on, and when | `org.setting_changed` events for `security.malwareProtection` | `cloudable events` |
| Which machines were built with protection | Cloudable records no per-machine event for the install. A machine created, reimaged or restored after the setting changed was built with it, and the extension write on the VM is in Azure's Activity Log | `cloudable events` for the dates; the Azure portal for the extension |
| Protection running on a machine | Not in Cloudable. The Defender portal for the subscription | Defender portal |
| Encryption at rest, drift, patch status | Existing columns of the same asset inventory | Same export |
| Who turned vulnerability scanning on, and when it was scheduled | `org.setting_changed` events for the `security.vulnerabilityScan.*` keys | `cloudable events` |
| The scanner was installed on a machine, and which version | `machine.scanner_installed` events (version and previous version) | `cloudable events` |
| Where each machine stands on scanning | `vulnerability_scan_status`, `last_scan_at`, `open_critical` and `open_high` columns of the asset inventory | `cloudable export asset-inventory` |
| Known vulnerabilities per machine: package, severity, fixed version, first seen, fix available since, resolved when | One row per finding, open and resolved, kept for the event retention window | `cloudable export vulnerabilities`, or `GET /api/v1/compliance/exports/vulnerabilities.csv` |
| Each scan, its counts and the age of the vulnerability database it used | `machine.vulnerability_scan_completed` and `machine.vulnerability_scan_failed` events | `cloudable events` |
| Scans are on schedule and fixes are on time | The `vulnerabilities-remediated` compliance check, under the `vulnerability-management` control | `cloudable export findings`, or the compliance page |

Vulnerability scanning is described in `docs/vulnerability-scanning.md`, including what it does
not cover.

## Not built yet

Listed so nobody reads their absence as an oversight.

- Vulnerability scanning of libraries people install for their own projects, and of container
  images. The vulnerability scan covers operating system packages only; see
  `docs/vulnerability-scanning.md`.
- An operator-triggered security update, and "updates due" measured against the operator's
  remediation deadlines. Until it exists, patching is whatever the distro does on its own.
- A compliance check for malware protection, and Defender health read back into Cloudable.
- Cloud-device checks: disk encryption, OS version, pending reboot.
- An agent-side audit of the baseline controls, to catch a setting changed after first boot.
  Today the label shows what was applied at provisioning, not what is true now.
- Per-organisation exceptions, and a choice of protection provider.
- Applying the baseline to machines that were provisioned before it existed. They need a
  reimage; that is an explicit, audited action and is not done for anyone automatically.
- Ubuntu 22.04 leaves standard support in 2027; the default image should move to 24.04 before
  then.
