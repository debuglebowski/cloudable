import { HARDENING_STAMP_PATH } from "@cloudable/contracts";

/**
 * The security baseline every new Azure machine boots with.
 *
 * A subset of the CIS Ubuntu Linux Benchmark, Level 1 (Server), applied by cloud-init
 * at first boot, with each deliberate deviation listed in `HARDENING_EXCEPTIONS` and in
 * `docs/hardening.md`. Controls are named by title rather than section number: the
 * numbering differs between the 22.04 and 24.04 benchmark versions.
 *
 * Applied at provisioning only. cloud-init's `scripts-user` is per-instance, so an
 * existing machine is never touched (invariant 10) and a reboot never re-runs it. A
 * reimage or restore builds a new instance and therefore applies the baseline again.
 *
 * The script runs as its own process, not inline, for two reasons: `set -e` is silently
 * disabled inside an `if` condition, so a failure halfway would otherwise go unnoticed;
 * and the script on disk is itself evidence of what was applied.
 *
 * The version stamp is written only after every control has been read back and matches.
 * A failed baseline leaves no stamp, the machine boots anyway so it stays visible and
 * remediable, and the agent reports "none".
 */

/** Written to the stamp file and reported by the agent. Bump when the control list changes. */
export const HARDENING_BASELINE = "cis-ubuntu-l1-v1";

export { HARDENING_STAMP_PATH };

/** Where the baseline script lands on the machine, for anyone auditing what ran. */
export const HARDENING_SCRIPT_PATH = "/usr/local/sbin/cloudable-harden";

export interface HardeningException {
  /** Stable id, written into the stamp file. Never renamed once released. */
  readonly id: string;
  /** The CIS control this deviates from, by title. */
  readonly control: string;
  /** What this build does instead. */
  readonly deviation: string;
  /** Why, in terms of what would break. */
  readonly reason: string;
}

export const HARDENING_EXCEPTIONS: readonly HardeningException[] = [
  {
    id: "ip-forwarding",
    control: "IP forwarding is disabled",
    deviation: "Left to the distro default, which Docker overrides when it starts.",
    reason: "Container networking needs the kernel to forward packets.",
  },
  {
    id: "udf-module",
    control: "udf kernel module is not available",
    deviation: "The module stays loadable.",
    reason: "Azure can hand the provisioning agent its first-boot data on a UDF volume.",
  },
  {
    id: "squashfs-module",
    control: "squashfs kernel module is not available",
    deviation: "The module stays loadable.",
    reason: "Snap packages and many container tools are squashfs images.",
  },
  {
    id: "core-dumps",
    control: "Core dump storage is disabled",
    deviation:
      "Core dumps for ordinary processes are left on. Only setuid programs are barred from dumping.",
    reason: "Developers debug crashes from core files.",
  },
  {
    id: "tmp-mount-options",
    control: "/tmp is a separate partition mounted nodev, nosuid and noexec",
    deviation: "/tmp stays on the root filesystem with default options.",
    reason: "Compilers, package builds and test runners execute files from /tmp.",
  },
  {
    id: "passwordless-sudo",
    control: "sudo requires authentication",
    deviation: "The machine's OS user keeps passwordless sudo.",
    reason:
      "No machine account has a password: sign-in is by short-lived certificate, so there is nothing to type.",
  },
  {
    id: "password-policy",
    control: "Password complexity and aging are configured",
    deviation: "Not configured.",
    reason:
      "No password exists to govern. Enforcing aging on a locked account can also block certificate sign-in.",
  },
  {
    id: "cron-restriction",
    control: "cron and at are restricted to authorized users",
    deviation: "The machine's user may schedule jobs.",
    reason: "Scheduled jobs are an ordinary part of a person's workflow on their own machine.",
  },
  {
    id: "default-umask",
    control: "Default user umask is 027 or more restrictive",
    deviation: "The distro default is kept.",
    reason:
      "One person owns each machine, and a stricter umask breaks files shared with containers and service users.",
  },
  {
    id: "bootloader-password",
    control: "Bootloader password is set",
    deviation: "Not set.",
    reason: "There is no physical console. Azure serial console access is governed by Azure RBAC.",
  },
  {
    id: "automatic-updates",
    control: "Updates, patches and security software are installed",
    deviation:
      "The distro's own automatic security updates are left as shipped. Cloudable does not manage or schedule patching yet.",
    reason:
      "Patching is meant to follow the operator's remediation deadlines through an operator-triggered action, which does not exist yet.",
  },
];

/** Kernel modules a server never needs. udf and squashfs are exceptions above. */
const DISABLED_MODULES = ["cramfs", "freevxfs", "hfs", "hfsplus", "jffs2", "usb-storage"] as const;

/**
 * Services masked only when the image already ships them. On the stock Canonical images
 * none are present, so this is a guard, not a removal: nothing is ever uninstalled
 * (invariant 4), and a person who installs one later does so on a machine where it was
 * never masked.
 */
const MASKED_IF_PRESENT = [
  "avahi-daemon",
  "cups",
  "isc-dhcp-server",
  "isc-dhcp-server6",
  "slapd",
  "nfs-server",
  "bind9",
  "vsftpd",
  "apache2",
  "dovecot",
  "smbd",
  "snmpd",
  "ypserv",
  "squid",
] as const;

const moduleLines = DISABLED_MODULES.map((m) => `install ${m} /bin/false\nblacklist ${m}`).join(
  "\n",
);

/**
 * The script body. No `${` and no backticks may appear below: this is a JS template
 * literal, so either would be interpolated by TypeScript instead of reaching bash.
 */
const HARDEN_SCRIPT = `#!/bin/bash
# Cloudable baseline: CIS Ubuntu Level 1 subset. See docs/hardening.md.
set -euo pipefail

BASELINE=${HARDENING_BASELINE}
STAMP=${HARDENING_STAMP_PATH}

fail() {
  echo "cloudable-harden: $1" >&2
  exit 1
}

expect() {
  # expect <what> <got> <want>
  if [ "$2" != "$3" ]; then
    fail "$1 is '$2', wanted '$3'"
  fi
}

# --- Kernel modules a server never needs ---
mkdir -p /etc/modprobe.d /etc/sysctl.d
cat > /etc/modprobe.d/60-cloudable-hardening.conf <<'EOF'
${moduleLines}
EOF

# --- Network and kernel parameters ---
# ip_forward is deliberately absent: see the ip-forwarding exception.
{
  echo "net.ipv4.conf.all.send_redirects = 0"
  echo "net.ipv4.conf.default.send_redirects = 0"
  echo "net.ipv4.conf.all.accept_redirects = 0"
  echo "net.ipv4.conf.default.accept_redirects = 0"
  echo "net.ipv4.conf.all.secure_redirects = 0"
  echo "net.ipv4.conf.default.secure_redirects = 0"
  echo "net.ipv4.conf.all.accept_source_route = 0"
  echo "net.ipv4.conf.default.accept_source_route = 0"
  echo "net.ipv4.conf.all.log_martians = 1"
  echo "net.ipv4.conf.default.log_martians = 1"
  echo "net.ipv4.conf.all.rp_filter = 1"
  echo "net.ipv4.conf.default.rp_filter = 1"
  echo "net.ipv4.icmp_echo_ignore_broadcasts = 1"
  echo "net.ipv4.icmp_ignore_bogus_error_responses = 1"
  echo "net.ipv4.tcp_syncookies = 1"
  # Absent when IPv6 is switched off, and an unknown key would fail the whole file.
  if [ -d /proc/sys/net/ipv6/conf/all ]; then
    echo "net.ipv6.conf.all.accept_redirects = 0"
    echo "net.ipv6.conf.default.accept_redirects = 0"
    echo "net.ipv6.conf.all.accept_source_route = 0"
    echo "net.ipv6.conf.default.accept_source_route = 0"
    echo "net.ipv6.conf.all.accept_ra = 0"
    echo "net.ipv6.conf.default.accept_ra = 0"
  fi
  # Only where the kernel has the Yama module, as the Azure Ubuntu kernels do.
  if [ -e /proc/sys/kernel/yama/ptrace_scope ]; then
    echo "kernel.yama.ptrace_scope = 1"
  fi
  echo "kernel.randomize_va_space = 2"
  echo "fs.suid_dumpable = 0"
} > /etc/sysctl.d/60-cloudable-hardening.conf
sysctl -p /etc/sysctl.d/60-cloudable-hardening.conf >/dev/null

# --- sshd ---
# A drop-in that sorts first: sshd keeps the FIRST value it reads, and the cloud image
# ships its own file in this directory. TrustedUserCAKeys is not touched here.
if [ -f /etc/ssh/sshd_config ]; then
  mkdir -p /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/00-cloudable-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
HostbasedAuthentication no
IgnoreRhosts yes
PermitUserEnvironment no
X11Forwarding no
LogLevel INFO
MaxAuthTries 4
LoginGraceTime 60
MaxStartups 10:30:60
ClientAliveInterval 300
ClientAliveCountMax 3
EOF
  chmod 600 /etc/ssh/sshd_config /etc/ssh/sshd_config.d/00-cloudable-hardening.conf
  # "sshd -t" refuses to run without its privilege separation directory, whatever the
  # config says. Ubuntu 24.04 socket-activates sshd, so on first boot nothing has created
  # it yet: found live, every Azure machine dropped the whole baseline on this line.
  # systemd's own unit creates the same directory with the same mode.
  install -d -m 0755 /run/sshd
  if ! sshd -t; then
    rm -f /etc/ssh/sshd_config.d/00-cloudable-hardening.conf
    fail "sshd rejected the hardening drop-in, removed it"
  fi
  # No-op when sshd is not running (socket-activated images read the file on first use).
  systemctl try-reload-or-restart ssh || true
fi

# --- sudo ---
cat > /etc/sudoers.d/60-cloudable-hardening <<'EOF'
Defaults use_pty
Defaults logfile="/var/log/sudo.log"
EOF
chmod 440 /etc/sudoers.d/60-cloudable-hardening
if ! visudo -cf /etc/sudoers.d/60-cloudable-hardening >/dev/null; then
  rm -f /etc/sudoers.d/60-cloudable-hardening
  fail "sudo rejected the hardening drop-in, removed it"
fi

# --- File permissions ---
chmod 644 /etc/passwd /etc/group
chown root:shadow /etc/shadow /etc/gshadow
chmod 640 /etc/shadow /etc/gshadow
if [ -e /etc/crontab ]; then chmod 600 /etc/crontab; fi
for d in /etc/cron.d /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
  if [ -d "$d" ]; then chmod 700 "$d"; fi
done

# --- Login banner: no OS or version detail ---
echo "Authorized use only." > /etc/issue
echo "Authorized use only." > /etc/issue.net

# --- Persistent journal ---
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/60-cloudable-hardening.conf <<'EOF'
[Journal]
Storage=persistent
Compress=yes
EOF
systemctl restart systemd-journald

# --- Services the image should not be running ---
for svc in ${MASKED_IF_PRESENT.join(" ")}; do
  if systemctl cat "$svc.service" >/dev/null 2>&1; then
    systemctl disable --now "$svc.service" >/dev/null 2>&1 || true
    systemctl mask "$svc.service" >/dev/null
  fi
done

# --- Read everything back. The stamp is only written if all of it holds. ---
expect "accept_redirects" "$(sysctl -n net.ipv4.conf.all.accept_redirects)" 0
expect "send_redirects" "$(sysctl -n net.ipv4.conf.all.send_redirects)" 0
expect "rp_filter" "$(sysctl -n net.ipv4.conf.all.rp_filter)" 1
expect "tcp_syncookies" "$(sysctl -n net.ipv4.tcp_syncookies)" 1
expect "randomize_va_space" "$(sysctl -n kernel.randomize_va_space)" 2
expect "suid_dumpable" "$(sysctl -n fs.suid_dumpable)" 0
for m in ${DISABLED_MODULES.join(" ")}; do
  # The install line, not the first line: modprobe prints a dependency's insmod first
  # (cramfs and jffs2 pull in mtd on the 24.04 Azure kernel) and pads every line with a
  # trailing space. Both broke this check live. No install line still fails it.
  expect "module $m" "$(modprobe -n -v "$m" 2>/dev/null | awk '$1=="install"{print $1, $2}' | tail -n1)" "install /bin/false"
done
expect "/etc/shadow mode" "$(stat -c %a /etc/shadow)" 640
expect "/etc/passwd mode" "$(stat -c %a /etc/passwd)" 644
if [ -f /etc/ssh/sshd_config ]; then
  expect "sshd permitrootlogin" "$(sshd -T | awk '$1=="permitrootlogin"{print $2}')" no
  expect "sshd passwordauthentication" "$(sshd -T | awk '$1=="passwordauthentication"{print $2}')" no
fi
expect "sudoers drop-in" "$(stat -c %a /etc/sudoers.d/60-cloudable-hardening)" 440
for svc in ${MASKED_IF_PRESENT.join(" ")}; do
  if systemctl cat "$svc.service" >/dev/null 2>&1; then
    expect "$svc" "$(systemctl is-enabled "$svc.service" 2>/dev/null || true)" masked
  fi
done

mkdir -p "$(dirname "$STAMP")"
printf '{"baseline":"%s","appliedAt":"%s","exceptions":${JSON.stringify(
  HARDENING_EXCEPTIONS.map((e) => e.id),
)}}\\n' "$BASELINE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAMP.tmp"
chmod 644 "$STAMP.tmp"
mv "$STAMP.tmp" "$STAMP"
echo "cloudable-harden: baseline $BASELINE applied"
`;

/**
 * The cloud-init fragment: writes the script, runs it, and carries on whether or not it
 * succeeded. The agent and tunnel daemon must come up either way, because a machine that
 * cannot report is a machine nobody can see or fix.
 */
export function hardeningSection(): string {
  return `mkdir -p "$(dirname ${HARDENING_SCRIPT_PATH})"
cat > ${HARDENING_SCRIPT_PATH} <<'CLOUDABLE_HARDEN_EOF'
${HARDEN_SCRIPT}CLOUDABLE_HARDEN_EOF
chmod 700 ${HARDENING_SCRIPT_PATH}
if ! ${HARDENING_SCRIPT_PATH}; then
  echo "cloudable: baseline hardening FAILED - continuing without it; the machine will report no baseline" >&2
fi`;
}
