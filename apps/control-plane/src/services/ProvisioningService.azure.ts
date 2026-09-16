// Real Azure ProvisioningService — self-hosted mode only (docs/cloud-auth.md:
// "fully managed mode uses a managed identity in Cloudable's own tenant ...
// same provisioning-layer code path"). This control plane manages machines
// in its OWN tenant/subscription via its own identity — never a customer's,
// never federation. The federated/BYOC credential exchange
// (docs/cloud-auth.md's OIDC token-mint flow) is not implemented by this
// adapter: `MachineDescriptor.orgId` is accepted (the port interface
// requires it, and it's used to tag resources) but never consulted to pick
// a credential. There is only ever one credential here.
//
// Network shell (VNet/subnet/NSG) and RBAC are Terraform's job
// (infra/terraform/control-plane/main.tf's `enable_self_managed_machines`
// resources) — this adapter only ever creates VMs/disks/NICs/public IPs
// that join a subnet Terraform already created and locked down (no inbound
// — invariant 7). It never creates or modifies a VNet, subnet, or NSG
// itself; the granted RBAC role doesn't even allow that (see that
// Terraform file's own comment).
import { ComputeManagementClient } from "@azure/arm-compute";
import type { NetworkInterface, PublicIPAddress } from "@azure/arm-network";
import { NetworkManagementClient } from "@azure/arm-network";
import { DefaultAzureCredential } from "@azure/identity";
import { MACHINE_OS_USER } from "@cloudable/contracts";
import { Effect, Layer } from "effect";
import { config } from "../config";
import {
  type CapturedDisk,
  type MachineDescriptor,
  type MachineStatus,
  ProvisioningError,
  type ProvisioningService,
  ProvisioningServiceTag,
  type ReimageDescriptor,
  type SnapshotDescriptor,
  type SnapshotResult,
} from "./ProvisioningService";

const DATA_DISK_SIZE_GB = 64;
const DATA_DISK_LUN = 0;

/** Canonical's Ubuntu Server gallery images. "ubuntu-XX.YY" only — an honest
 * rejection rather than guessing at an unrelated base image, same
 * convention as ProvisioningService.docker.ts's `ubuntuVersionFor`. Exported
 * as the one source of truth `services/CloudCatalogService.ts` seeds the
 * org-facing image catalog from — Azure has no API enumerating "images
 * compatible with our cloud-init setup" the way it does for regions, so this
 * hand-maintained map doubles as that catalog rather than drifting from it. */
// `architecture` is the image's real requirement, not decoration -- it's
// what `CloudCatalogService.ts`'s size sync filters against, and what
// `MachineService.create`/the Add Machine form compare a chosen size's own
// architecture capability to. Both entries confirmed Gen2 x64 this session:
// 22.04's own sku is literally "22_04-lts-gen2"; 24.04's `ubuntu-24_04-lts`
// offer has no Gen1 counterpart at all (Canonical stopped publishing one).
export const UBUNTU_IMAGES: Record<string, { offer: string; sku: string; architecture: string }> = {
  "ubuntu-22.04": {
    offer: "0001-com-ubuntu-server-jammy",
    sku: "22_04-lts-gen2",
    architecture: "x64",
  },
  "ubuntu-24.04": { offer: "ubuntu-24_04-lts", sku: "server", architecture: "x64" },
};

export function imageReferenceFor(image: string | undefined) {
  const key = image ?? "ubuntu-22.04";
  const match = UBUNTU_IMAGES[key];
  if (!match) return null;
  return {
    publisher: "Canonical",
    offer: match.offer,
    sku: match.sku,
    version: "latest",
  };
}

/** Azure VM names allow alphanumerics/underscores/periods/hyphens, but the
 * charset shared by every resource type `namesFor` produces (VM/NIC/PIP all
 * allow it, disks additionally forbid periods) is alphanumerics + hyphens —
 * so that's all this ever emits, regardless of the machine's real name. */
const MAX_SLUG_LENGTH = 32;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/** Azure-name-safe resource names derived from machineId (and, when given, a
 * human-readable prefix from the machine's own name) — archive/reconcile/
 * reimage never need to persist anything extra to find a machine's
 * resources back, same convention as ProvisioningService.docker.ts's
 * `containerName(machineId)`.
 *
 * `name` is optional and, when present, sanitized and capped at
 * `MAX_SLUG_LENGTH` — only 12 of the machineId's 32 hex characters are used
 * alongside it (still ~2.8×10¹⁴ combinations against this deployment's one
 * shared resource group, astronomically collision-safe at any real scale)
 * to leave headroom under the tightest real Azure limit, the VM resource
 * name's 64 characters (`cldm-` + 32-char slug + `-` + 12 hex = 50, a real
 * margin — verified against Microsoft's naming-rules table, not guessed).
 * Falls back to the exact previous id-only scheme when `name` is absent or
 * sanitizes to nothing (e.g. a name that's only non-ASCII/punctuation) —
 * still just as collision-safe, since that path keeps the full id. */
export function namesFor(machineId: string, name?: string) {
  const compactId = machineId.replace(/-/g, "");
  const slug = name ? slugify(name) : "";
  const base = slug ? `cldm-${slug}-${compactId.slice(0, 12)}` : `cldm${compactId}`;
  return namesForBase(base);
}

/** Every name `namesFor` produces derives from one `base` string — factored
 * out so a `base` recovered from an *existing* resource (via
 * `parseVmNameFromResourceId`, or a tag-based lookup) produces the exact same
 * NIC/PIP/disk names `namesFor` would have, without re-deriving `base` itself
 * from `(machineId, name)` and risking a mismatch. */
function namesForBase(base: string) {
  return {
    vm: base,
    nic: `${base}-nic`,
    pip: `${base}-pip`,
    osDisk: `${base}-os`,
    dataDisk: `${base}-data`,
    computerName: base.slice(0, 15),
  };
}

/** Extracts a VM's resource name from its full ARM resource id
 * (`.../providers/Microsoft.Compute/virtualMachines/<name>`), or `null` if
 * `id` isn't shaped like one. Used by `resolveVmNames` to recover the exact
 * name `create()` minted, instead of ever re-guessing it from `(machineId,
 * name)` again. */
export function parseVmNameFromResourceId(id: string): string | null {
  const match = /\/virtualMachines\/([^/]+)$/i.exec(id);
  return match ? (match[1] ?? null) : null;
}

/**
 * Resolves the resource names for an *existing* VM — used by
 * `archive`/`reconcile`/`restart`/`reimage`, every method that looks up a
 * machine that (unlike `create`) already exists, instead of minting one.
 *
 * The whole point: never re-derive a name from `(machineId, name)` at a
 * lookup site again. Two call sites already forgot to pass `name` at all
 * (`reconcile-machine.ts`, `domain/archive/archive.ts`) — one left the
 * reconcile loop permanently unable to promote any named Azure machine out
 * of "provisioning", the other silently abandoned a live VM while marking it
 * archived. A wrong guess doesn't just risk being wrong; it's indistinguishable
 * from "the resource is genuinely gone" (both 404), which is actively
 * dangerous for `archive`. Reusing the ID Azure itself returned at creation
 * removes the guesswork entirely.
 *
 * - If `externalId` parses to a VM name: build every other resource name from
 *   it directly (`namesForBase`). One direct lookup below, same cost as the
 *   old happy path — no extra ARM calls for the common case.
 * - If `externalId` is `null` (a row that predates this change, or one whose
 *   `create()` call somehow didn't persist it) — or the direct lookup 404s —
 *   self-heal: every VM is tagged `cloudable-machine-id` at creation (see
 *   `create`'s own `tags`), so list VMs in the machines resource group once
 *   and find the one carrying this machine's id. Exact and unambiguous, no
 *   guessing, and it only runs on this cold/broken path — never in steady
 *   state, so it adds no per-pass ARM load for already-healthy machines.
 * - Either way, returns the resolved names *and* the VM's real resource id,
 *   so a caller can report the corrected `externalId` back — every reconcile
 *   pass's `persistReconcileResult` already writes `externalResourceId` from
 *   `MachineStatus.externalId`, so a self-healed row fixes itself permanently
 *   in the DB on its very first successful pass.
 * - If neither the direct lookup nor the tag search find anything, this
 *   fails with a real `not_found` — now a trustworthy signal (genuinely no
 *   VM exists), not a false positive from a wrong guess.
 */
const resolveVmNames = (
  clients: ArmClients,
  rg: string,
  machineId: string,
  externalId: string | null,
): Effect.Effect<
  { names: ReturnType<typeof namesForBase>; resourceId: string },
  ProvisioningError
> =>
  Effect.gen(function* () {
    const knownName = externalId ? parseVmNameFromResourceId(externalId) : null;

    if (knownName) {
      const direct = yield* runArm(() => clients.compute.virtualMachines.get(rg, knownName)).pipe(
        Effect.map((vm) => ({ names: namesForBase(knownName), resourceId: vm.id ?? knownName })),
        Effect.catchTag("ProvisioningError", (error) =>
          error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
        ),
      );
      if (direct) return direct;
    }

    // Self-heal: no usable stored id, or the direct lookup 404'd. Ask Azure
    // directly, by the one fact that's never guessed — the tag it stamped on
    // the VM itself at creation. `.list()` returns a lazily-paged async
    // iterable, not a `Promise` — the iteration itself (each page is a real
    // HTTP call) is what needs wrapping, not the call that creates it.
    const found = yield* runArm(async () => {
      for await (const vm of clients.compute.virtualMachines.list(rg)) {
        if (vm.tags?.["cloudable-machine-id"] === machineId && vm.name) return vm;
      }
      return null;
    });
    if (found?.name) {
      return { names: namesForBase(found.name), resourceId: found.id ?? found.name };
    }

    return yield* Effect.fail(
      new ProvisioningError({
        reason: "not_found",
        cause: `no VM found for machine ${machineId} (tried externalId=${externalId ?? "null"}, tag search)`,
      }),
    );
  });

/**
 * `/home` lives on the data disk, not the OS disk.
 *
 * `reimage` (this file) deletes the VM and its OS DISK and re-attaches the same data
 * disk. Until this section existed, the person's work lived in `/home/cloudable` on the
 * OS disk while the data disk was formatted, mounted at `/mnt/cloudable-data`, and
 * written to by nothing at all — one reference, repo-wide. So an upgrade destroyed the
 * work and carefully preserved an empty volume. Observed in production: the
 * `machine.reimaged` of 2026-09-14 took a machine's home with it.
 *
 * This runs at cloud-init's `scripts-user` (final stage), strictly after `users-groups`
 * (init stage) — so `cloudable` and `/home/cloudable` already exist, created by Azure
 * from `osProfile.adminUsername`, on the OS disk. That home is what moves onto the disk
 * that survives. The ordering is ASSERTED rather than assumed: a missing account aborts,
 * because every ownership decision below would otherwise be made against a guess.
 *
 * The three paths this has to be right on:
 *
 *   first boot — no filesystem, or one with no marker: seed from the OS-disk home, then
 *                mount at `/home`.
 *   reboot     — this does NOT run. `scripts-user` is per-instance, not per-boot;
 *                `/etc/fstab` is the only thing that mounts `/home`.
 *   reimage    — fresh OS disk, so Azure creates a brand-new skel `/home/cloudable`
 *                again. The disk wins; the skel home is moved aside, never merged.
 *
 * Exported separately from `cloudInitFor` so the tests can assert against it directly,
 * and so the one-off migration runbook for machines provisioned before this landed
 * (`docs/lifecycle.md`) quotes one source of truth instead of drifting from it.
 */
export function homeVolumeSection(dataDiskLun: number): string {
  return `OS_USER=${MACHINE_OS_USER}
DISK_LINK=/dev/disk/azure/scsi1/lun${dataDiskLun}
STAGE=/run/cloudable-disk
MARKER=.cloudable-home-volume
OSDISK_HOME=/home.pre-cloudable

setup_home_volume() {
  if ! getent passwd "$OS_USER" >/dev/null; then
    echo "cloudable: OS user $OS_USER does not exist yet - refusing to touch /home" >&2
    exit 1
  fi

  # Azure's udev rule is what makes this path stable; /dev/sdX letters are not.
  # readlink -f prints a non-existent path and still exits 0, so the block test is the
  # real check. Written as an if, not "[ -b ... ] && break": under set -e a trailing
  # false AND-list is the last command of the loop body and would abort the script.
  WAITED=0
  while [ "$WAITED" -lt 60 ]; do
    if [ -b "$DISK_LINK" ]; then break; fi
    sleep 2
    WAITED=$((WAITED + 2))
  done
  if [ ! -b "$DISK_LINK" ]; then
    echo "cloudable: data disk $DISK_LINK never appeared" >&2
    exit 1
  fi
  DEVICE=$(readlink -f "$DISK_LINK")

  # The only destructive command here, and it runs only when the device carries no
  # filesystem signature at all. A disk holding a home always has one, so a reimage can
  # never reach it. -m 1 because ext4 otherwise reserves 5% - over 3 GiB of a 64 GiB
  # volume - for root, which is pointless on a one-person data volume.
  if ! blkid "$DEVICE" >/dev/null 2>&1; then
    mkfs.ext4 -F -m 1 -L cloudable-home "$DEVICE"
  fi

  mkdir -p "$STAGE"
  mount "$DEVICE" "$STAGE"
  if [ -e "$STAGE/$MARKER" ]; then SEEDED=yes; else SEEDED=no; fi

  # A reimaged VM creates the account from scratch. It normally lands on uid 1000 again,
  # but nothing guarantees it, and a shifted uid means the person cannot read their own
  # files. That is a security property here, not a convenience: the file browser
  # (tunnel-daemon/src/fs-helper.ts) has no path allowlist by design and relies entirely
  # on the OS deciding against the uid it dropped to.
  #
  # Move the ACCOUNT to the files, not the files to the account: usermod is O(1) and
  # preserves every non-cloudable ownership inside the home - root-owned files from the
  # person's own sudo, a container's data directory - that a blanket chown -R flattens
  # irrecoverably. usermod re-chowns the account's home itself, which is exactly why
  # this runs while /home/cloudable is still the small skel home on the OS disk, before
  # the real one is mounted.
  if [ "$SEEDED" = yes ] && [ -d "$STAGE/$OS_USER" ]; then
    WANT_UID=$(stat -c %u "$STAGE/$OS_USER")
    WANT_GID=$(stat -c %g "$STAGE/$OS_USER")
    # >= 1000 only: if the home on the disk somehow ended up root-owned, moving the
    # account onto uid 0 would be catastrophic. The scoped chown below covers that case.
    if [ "$WANT_UID" -ge 1000 ] && [ "$WANT_UID" != "$(id -u "$OS_USER")" ]; then
      usermod -u "$WANT_UID" "$OS_USER" || echo "cloudable: uid $WANT_UID taken, re-owning instead" >&2
    fi
    if [ "$WANT_GID" -ge 1000 ] && [ "$WANT_GID" != "$(id -g "$OS_USER")" ]; then
      groupmod -g "$WANT_GID" "$OS_USER" || echo "cloudable: gid $WANT_GID taken, re-owning instead" >&2
    fi
  fi
  umount "$STAGE"
  rmdir "$STAGE"

  # Renamed, not deleted: it is the only copy of whatever was there, and a rename within
  # one filesystem is atomic and free. No rm -rf near /home in a boot script.
  # Renamed, not merely mounted over: if the disk ever fails to mount, a /home still
  # holding a plausible skel home is the exact trap this change exists to remove - the
  # person sees a home, believes it, works in it, loses it. An empty /home is an obvious
  # fault; a fresh-looking one is an invisible one.
  if [ -e "$OSDISK_HOME" ]; then OSDISK_HOME=$OSDISK_HOME.$(date +%s); fi
  mv /home "$OSDISK_HOME"
  mkdir -m 755 /home

  # By UUID, not the /dev/sdX that readlink resolves to - which is what the previous
  # version of this section wrote into fstab. Azure SCSI letters are not stable across
  # reboots, so that line could mount nothing, or the wrong disk, and nofail made it
  # silent.
  #
  # nofail is KEPT, and is not sufficient on its own: systemd-fstab-generator reads it
  # as "do not order this mount before local-fs.target", so boot proceeds without
  # waiting and the tunnel daemon could su into an unmounted /home.
  # RequiresMountsFor=/home on that unit is what closes the race. nofail stays because
  # a required mount that fails takes local-fs.target with it into emergency mode, and
  # there is no way back into one of these machines: no inbound access by design
  # (invariant 7), and the serial console wants an admin password that
  # throwawayAdminPassword() deliberately discards.
  #
  # Rewritten rather than appended: scripts-user re-runs whenever the instance id
  # changes, not only on a new machine, and the migration runbook writes this same line.
  DISK_UUID=$(blkid -s UUID -o value "$DEVICE")
  if grep -qs "^[^#].*[[:space:]]/home[[:space:]]" /etc/fstab; then
    grep -v "^[^#].*[[:space:]]/home[[:space:]]" /etc/fstab > /etc/fstab.new || true
    if [ -s /etc/fstab.new ]; then mv /etc/fstab.new /etc/fstab; else rm -f /etc/fstab.new; fi
  fi
  echo "UUID=$DISK_UUID /home ext4 defaults,nofail,x-systemd.device-timeout=30s 0 2" >> /etc/fstab

  # "mount /home", not "mount $DEVICE /home", deliberately: it resolves through the line
  # just written, so a bad fstab entry fails here and now on a machine with nothing to
  # lose, instead of at the next reboot on a machine with a year of work on it. Under
  # set -euo pipefail that abort happens before a single systemd unit is installed, so
  # the machine never comes up half-configured.
  mount /home

  if [ "$SEEDED" = no ]; then
    cp -a "$OSDISK_HOME/." /home/
    # Marker last, after sync: a copy interrupted half way leaves no marker, so the next
    # boot seeds again instead of mounting a half-populated home and declaring victory.
    sync
    echo "seeded_at=$(date -Is)" > "/home/$MARKER"
    chmod 600 "/home/$MARKER"
  fi

  # Last resort, and the reason the >= 1000 guards above can afford to be timid. Scoped
  # with --from, so only files that belonged to the OLD account are touched and anything
  # deliberately owned by root or a service inside the home survives. An unconditional
  # chown -R on every boot is not acceptable here: O(files) on a 64 GiB volume in front
  # of the daemon that serves sessions, it clears setuid bits, and it destroys ownership
  # information nothing can reconstruct.
  HOME_DIR=/home/$OS_USER
  if [ ! -d "$HOME_DIR" ]; then
    mkdir -m 700 "$HOME_DIR"
    chown "$OS_USER:$OS_USER" "$HOME_DIR"
  fi
  OWNER_UID=$(stat -c %u "$HOME_DIR")
  OWNER_GID=$(stat -c %g "$HOME_DIR")
  if [ "$OWNER_UID" != "$(id -u "$OS_USER")" ] || [ "$OWNER_GID" != "$(id -g "$OS_USER")" ]; then
    chown -R --from="$OWNER_UID:$OWNER_GID" "$OS_USER:$OS_USER" "$HOME_DIR"
  fi
}

# Skip the whole thing if a previous run already did it: cloud-init re-runs scripts-user
# whenever the instance id changes, not only on a new machine.
if mountpoint -q /home; then
  echo "cloudable: /home is already a mount point, leaving it alone"
else
  setup_home_volume
fi`;
}

/** Every binary this cloud-init installs is public (same posture as the
 * now-public GHCR control-plane image) — no token to inject. Unlike the
 * join-token adapters (docker/fake), the agent gets its own attestation
 * credential locally, from Azure IMDS, once it's running — nothing for the
 * control plane to hand it here. */
export function cloudInitFor(desc: MachineDescriptor, dataDiskLun: number): string {
  const packages = (desc.packages ?? []).join(" ");
  const script = `#!/bin/bash
set -euo pipefail

${homeVolumeSection(dataDiskLun)}

mkdir -p /opt/cloudable
ARCH=$(uname -m)
[ "$ARCH" = "aarch64" ] && ARCH=arm64 || ARCH=x64
curl -fsSL "${config.controlPlaneBaseUrl}/_internal/binaries/cloudable-agent-linux-$ARCH" -o /opt/cloudable/agent
curl -fsSL "${config.controlPlaneBaseUrl}/_internal/binaries/cloudable-tunnel-daemon-linux-$ARCH" -o /opt/cloudable/tunnel-daemon
chmod +x /opt/cloudable/agent /opt/cloudable/tunnel-daemon

cat > /etc/systemd/system/cloudable-agent.service <<UNIT
[Unit]
Description=Cloudable control agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=/opt/cloudable/agent
Restart=always
RestartSec=5
Environment=CONTROL_PLANE_URL=${config.controlPlaneBaseUrl}
Environment=ATTESTATION_METHOD=managed_identity
Environment=CLOUDABLE_PACKAGES=${packages}

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/cloudable-tunnel-daemon.service <<UNIT
[Unit]
Description=Cloudable tunnel daemon
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0
# Every session this daemon opens is "su - cloudable" (pty.ts) or
# "su - cloudable -c ... --fs-helper" (files-session.ts), both of which land in
# /home/cloudable. Starting before the data disk is mounted there hands the person a
# shell in a home that is not theirs and that the next upgrade deletes - the exact
# failure this change exists to prevent. RequiresMountsFor pulls in home.mount and
# orders this unit after it, which is precisely the ordering nofail in /etc/fstab does
# not provide.
# Deliberately NOT on cloudable-agent.service: if the disk is genuinely missing the
# agent must still come up and report, or a broken /home would also make the machine
# invisible to the control plane and un-remediable by reimage.
RequiresMountsFor=/home

[Service]
ExecStart=/opt/cloudable/tunnel-daemon
Restart=always
RestartSec=5
Environment=CONTROL_PLANE_URL=${config.controlPlaneBaseUrl}
Environment=ATTESTATION_METHOD=managed_identity

[Install]
WantedBy=multi-user.target
UNIT

# After the fstab write above, so the generator has produced home.mount by the time the
# tunnel daemon's RequiresMountsFor=/home is resolved.
systemctl daemon-reload
systemctl enable --now cloudable-agent
systemctl enable --now cloudable-tunnel-daemon
`;
  return Buffer.from(script, "utf-8").toString("base64");
}

interface ArmClients {
  compute: ComputeManagementClient;
  network: NetworkManagementClient;
  subscriptionId: string;
  subnetId: string;
}

let cached: ArmClients | null = null;

/** Lazy, memoized — constructing `ComputeManagementClient`/`NetworkManagementClient`
 * eagerly at module load would run even when a different adapter is
 * selected (`ProvisioningService.switchable.ts` constructs every adapter's
 * layer up front, regardless of which one dispatch actually uses), and
 * `config.azureSubscriptionId`/`azureMachinesSubnetId` are `null` unless
 * this adapter is actually configured. Fails closed, per-call, instead. */
const getClients = (): Effect.Effect<ArmClients, ProvisioningError> =>
  Effect.gen(function* () {
    if (cached) return cached;
    const { azureSubscriptionId: subscriptionId, azureMachinesSubnetId: subnetId } = config;
    if (!subscriptionId || !subnetId) {
      return yield* Effect.fail(
        new ProvisioningError({
          reason: "provider_error",
          cause:
            "AZURE_SUBSCRIPTION_ID / AZURE_MACHINES_SUBNET_ID not configured — see infra/terraform/control-plane's machines_subnet_id output",
        }),
      );
    }
    const credential = new DefaultAzureCredential();
    cached = {
      compute: new ComputeManagementClient(credential, subscriptionId),
      network: new NetworkManagementClient(credential, subscriptionId),
      subscriptionId,
      subnetId,
    };
    return cached;
  });

/**
 * Azure reports a VM's power state as `PowerState/<x>` in its instance view, or omits
 * it entirely while the VM is still being built or has failed provisioning.
 *
 * A machine that is off is `stopped`, not an error. Reporting every non-running state
 * as `error` is what made a merely deallocated machine show up in the console as
 * "Error — provider reconcile reported state error", which is both wrong and alarming.
 * Transitional states report `provisioning`: the machine is mid-move, and the next
 * reconcile pass a minute later sees where it landed.
 */
export function machineStateForPowerState(powerState: string | undefined): MachineStatus["state"] {
  switch (powerState) {
    case "PowerState/running":
      return "running";
    case "PowerState/stopped":
    case "PowerState/deallocated":
      return "stopped";
    case "PowerState/starting":
    case "PowerState/stopping":
    case "PowerState/deallocating":
      return "provisioning";
    default:
      return "error";
  }
}

/** Azure SDK errors are `RestError`-shaped (`.statusCode`) but not a class
 * this package depends on directly — read the field defensively rather
 * than importing `@azure/core-rest-pipeline` just for an instanceof check. */
export function classifyAzureError(cause: unknown): ProvisioningError["reason"] {
  const statusCode = (cause as { statusCode?: unknown } | undefined)?.statusCode;
  if (statusCode === 404) return "not_found";
  if (statusCode === 409 || statusCode === 429) return "quota_exceeded";
  return "provider_error";
}

const runArm = <A>(op: () => Promise<A>): Effect.Effect<A, ProvisioningError> =>
  Effect.tryPromise({
    try: op,
    catch: (cause) => new ProvisioningError({ reason: classifyAzureError(cause), cause }),
  });

/**
 * For one teardown step whose target being absent IS its goal state: a 404 means the
 * resource is already gone, so the step has nothing left to do and the sequence
 * continues. Every other failure still fails the archive.
 *
 * Without this, a single mid-sequence 404 propagated out of `archive`, and
 * `domain/archive/archive.ts` reads any `not_found` from this port as "no live infra
 * for this machine" and marks the machine archived. Observed in production on
 * 2026-09-12: a machine whose VM was deleted and snapshotted reported a successful
 * archive while its OS disk, data disk, NIC and public IP stayed alive and billing.
 * Only `resolveVmNames` should be able to produce that "nothing exists" signal.
 */
const tolerateAlreadyGone = <A>(
  effect: Effect.Effect<A, ProvisioningError>,
): Effect.Effect<A | null, ProvisioningError> =>
  effect.pipe(
    Effect.catchTag("ProvisioningError", (error) =>
      error.reason === "not_found" ? Effect.succeed(null) : Effect.fail(error),
    ),
  );

/** Azure requires either an admin password or an SSH public key on every
 * Linux VM at creation — there is no "neither" option. A random, per-VM,
 * never-stored password satisfies that requirement; it's never logged,
 * returned, or reused, and the NSG Terraform attaches to the subnet
 * (infra/terraform/control-plane/main.tf) denies ALL inbound traffic
 * regardless — including port 22 — so nothing can ever attempt to use it.
 * Real access to a machine is exclusively via the tunnel daemon + SSH CA
 * (docs/access.md), never this.
 *
 * A single `crypto.randomUUID()`, not two: `"Cldm-" + uuid + "-" + uuid` is
 * 5 + 36 + 1 + 36 = 78 characters, over Azure's own 72-character maximum for
 * a Linux VM admin password — confirmed live, this failed VM creation on
 * every real Azure machine that got far enough in Azure's validation
 * pipeline to reach the password field (masked until now by this session's
 * other fixes, which were rejecting most requests earlier — on SKU/region
 * compatibility — before ever reaching this check) with `provider_error: The
 * supplied password must be between 6-72 characters long...`. One UUID
 * keeps this at 5 + 36 = 41 characters, comfortably under the limit, and
 * still deterministically satisfies at least 3 of Azure's 5 complexity
 * categories without relying on randomness: "Cldm-" alone guarantees
 * uppercase ("C"), lowercase ("ldm"), and a special character (the hyphen);
 * a v4 UUID's fixed version nibble additionally guarantees a literal "4"
 * digit at a known position. */
export function throwawayAdminPassword(): string {
  return `Cldm-${crypto.randomUUID()}`;
}

const createNetworking = (
  clients: ArmClients,
  resourceGroup: string,
  location: string,
  names: ReturnType<typeof namesFor>,
): Effect.Effect<NetworkInterface, ProvisioningError> =>
  Effect.gen(function* () {
    const pip: PublicIPAddress = yield* runArm(() =>
      clients.network.publicIPAddresses.beginCreateOrUpdateAndWait(resourceGroup, names.pip, {
        location,
        sku: { name: "Standard" },
        publicIPAllocationMethod: "Static",
      }),
    );

    return yield* runArm(() =>
      clients.network.networkInterfaces.beginCreateOrUpdateAndWait(resourceGroup, names.nic, {
        location,
        ipConfigurations: [
          {
            name: "ipconfig1",
            subnet: { id: clients.subnetId },
            publicIPAddress: { id: pip.id as string },
          },
        ],
      }),
    );
  });

const createDataDisk = (
  clients: ArmClients,
  resourceGroup: string,
  location: string,
  names: ReturnType<typeof namesFor>,
) =>
  runArm(() =>
    clients.compute.disks.beginCreateOrUpdateAndWait(resourceGroup, names.dataDisk, {
      location,
      diskSizeGB: DATA_DISK_SIZE_GB,
      creationData: { createOption: "Empty" },
      // StandardSSD, not Premium — desc.sizeSku is free text (passed straight
      // through to hardwareProfile.vmSize), and not every VM size supports
      // premium storage. StandardSSD works with all of them.
      sku: { name: "StandardSSD_LRS" },
    }),
  );

const dataDiskIdFor = (
  clients: ArmClients,
  resourceGroup: string,
  names: ReturnType<typeof namesFor>,
): string =>
  `/subscriptions/${clients.subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Compute/disks/${names.dataDisk}`;

/**
 * Deletes whatever a failed `create` had already built. The NIC, public IP and data
 * disk are created before the VM, so a VM creation that fails — a rejected SKU, an
 * over-long admin password, a region without capacity — used to leave all three behind
 * permanently, billing, with nothing in the system that would ever clean them up. Four
 * machines' worth were found orphaned in production on 2026-09-13.
 *
 * Best-effort by construction: every delete swallows its own failure, because this runs
 * while an error is already on its way to the caller and must never replace it with a
 * second one. Safe to run against resources that were never created — `create` is only
 * called for a machine with no live infrastructure (see `reconcile-machine.ts`), and
 * every name here is derived from that machine's own id.
 */
const rollbackPartialCreate = (
  clients: ArmClients,
  rg: string,
  names: ReturnType<typeof namesFor>,
): Effect.Effect<void> =>
  Effect.all(
    [
      runArm(() => clients.compute.virtualMachines.beginDeleteAndWait(rg, names.vm)),
      runArm(() => clients.compute.disks.beginDeleteAndWait(rg, names.osDisk)),
      runArm(() => clients.compute.disks.beginDeleteAndWait(rg, names.dataDisk)),
      runArm(() => clients.network.networkInterfaces.beginDeleteAndWait(rg, names.nic)),
      runArm(() => clients.network.publicIPAddresses.beginDeleteAndWait(rg, names.pip)),
    ].map((step) => step.pipe(Effect.ignore)),
    // Sequential, not concurrent: a NIC cannot be deleted while the VM still
    // references it, nor a public IP while the NIC does.
    { discard: true },
  );

/**
 * Point-in-time copy of one disk, named after it. A snapshot's location must match its
 * source disk's, so it is read off the disk rather than assumed to match the machine's
 * own region.
 *
 * Returns the id and real size Azure reports back. This used to discard the result
 * (`Effect<unknown>`), which is how the control plane ended up recording snapshots it
 * could not name: the copy existed, nothing wrote down where.
 */
const snapshotOf = (
  clients: ArmClients,
  rg: string,
  kind: CapturedDisk["kind"],
  snapshotId: string,
  disk: { name?: string; id?: string; location?: string },
): Effect.Effect<CapturedDisk, ProvisioningError> =>
  runArm(() =>
    // The row id's first 8 hex characters, not the bare `<disk>-snap` this used to be:
    // that name is identical for every snapshot of a given disk, so the second one
    // overwrote the first through beginCreateOrUpdate. Eight hex characters keep the
    // name inside Azure's 80-character limit for even the longest machine name while
    // making a collision within one machine's snapshots not a practical concern.
    clients.compute.snapshots.beginCreateOrUpdateAndWait(
      rg,
      `${disk.name}-snap-${snapshotId.replaceAll("-", "").slice(0, 8)}`,
      {
        location: disk.location ?? "",
        creationData: { createOption: "Copy", sourceResourceId: disk.id as string },
      },
    ),
  ).pipe(
    Effect.map((snapshot) => ({
      kind,
      externalId: snapshot.id ?? "",
      sizeBytes: snapshot.diskSizeBytes ?? 0,
    })),
  );

const service: ProvisioningService = {
  create: (desc: MachineDescriptor) =>
    Effect.gen(function* () {
      const imageReference = imageReferenceFor(desc.image);
      if (!imageReference) {
        return yield* Effect.fail(
          new ProvisioningError({
            reason: "provider_error",
            cause: `Azure adapter only supports "ubuntu-XX.YY" images, got: ${desc.image}`,
          }),
        );
      }
      // `MachineDescriptor.region` is nullable at the port level (docker/fake
      // have no region concept) — the org/machine-creation layer above
      // always supplies one for provider "azure" (see
      // `MachineService.create`'s catalog validation), so this is a
      // fail-closed sanity check, not the primary enforcement.
      if (!desc.region) {
        return yield* Effect.fail(
          new ProvisioningError({ reason: "provider_error", cause: "azure requires a region" }),
        );
      }
      const region = desc.region;
      const clients = yield* getClients();
      const names = namesFor(desc.machineId, desc.name);
      const tags = { "cloudable-machine-id": desc.machineId, "cloudable-org-id": desc.orgId };

      // Everything from here on creates real resources, so anything that fails part
      // way through has to take its own leftovers with it — see
      // `rollbackPartialCreate`.
      const nic = yield* createNetworking(
        clients,
        config.azureMachinesResourceGroup,
        region,
        names,
      );
      const dataDisk = yield* createDataDisk(
        clients,
        config.azureMachinesResourceGroup,
        region,
        names,
      );

      const vm = yield* runArm(() =>
        clients.compute.virtualMachines.beginCreateOrUpdateAndWait(
          config.azureMachinesResourceGroup,
          names.vm,
          {
            location: region,
            tags,
            identity: { type: "SystemAssigned" },
            hardwareProfile: { vmSize: desc.sizeSku },
            storageProfile: {
              imageReference,
              osDisk: {
                name: names.osDisk,
                createOption: "FromImage",
                managedDisk: { storageAccountType: "Standard_LRS" },
              },
              dataDisks: [
                {
                  lun: DATA_DISK_LUN,
                  createOption: "Attach",
                  managedDisk: { id: dataDisk.id as string },
                },
              ],
            },
            osProfile: {
              computerName: names.computerName,
              adminUsername: MACHINE_OS_USER,
              adminPassword: throwawayAdminPassword(),
              customData: cloudInitFor(desc, DATA_DISK_LUN),
            },
            networkProfile: { networkInterfaces: [{ id: nic.id as string }] },
          },
        ),
      );

      return {
        machineId: desc.machineId,
        state: "provisioning",
        externalId: vm.id ?? null,
        reportedPackages: desc.packages ?? [],
      } satisfies MachineStatus;
    }).pipe(
      // `catchTag` rather than `tapError`: the rollback needs the clients and names,
      // which only exist inside the generator, so it is re-derived here from the
      // descriptor — the same pure `namesFor(machineId, name)` the body used.
      Effect.catchTag("ProvisioningError", (error) =>
        Effect.gen(function* () {
          const clients = yield* getClients().pipe(Effect.option);
          if (clients._tag === "Some") {
            yield* rollbackPartialCreate(
              clients.value,
              config.azureMachinesResourceGroup,
              namesFor(desc.machineId, desc.name),
            );
          }
          return yield* Effect.fail(error);
        }),
      ),
    ),

  snapshot: (desc: SnapshotDescriptor) =>
    Effect.gen(function* () {
      const clients = yield* getClients();
      const rg = config.azureMachinesResourceGroup;
      const { names } = yield* resolveVmNames(clients, rg, desc.machineId, desc.externalId);

      // Archive can stop the machine first and gets a quiesced copy for it. An upgrade
      // cannot — the machine must stay up until `reimage` replaces it — so its
      // pre-upgrade copy is crash-consistent. Tolerated-already-gone because a machine
      // whose VM has vanished is still worth snapshotting the surviving disks of.
      if (desc.quiesce) {
        yield* tolerateAlreadyGone(
          runArm(() => clients.compute.virtualMachines.beginDeallocateAndWait(rg, names.vm)),
        );
      }

      const disks: CapturedDisk[] = [];

      // "shallow" skips the OS disk deliberately: /home lives on the data disk
      // (`homeVolumeSection`), and the OS is rebuilt from its image. It is the cheap
      // copy of the part that cannot be recreated.
      if (desc.scope === "full") {
        const osDisk = yield* tolerateAlreadyGone(
          runArm(() => clients.compute.disks.get(rg, names.osDisk)),
        );
        if (osDisk) disks.push(yield* snapshotOf(clients, rg, "os", desc.snapshotId, osDisk));
      }

      const dataDisk = yield* tolerateAlreadyGone(
        runArm(() => clients.compute.disks.get(rg, names.dataDisk)),
      );
      if (dataDisk) disks.push(yield* snapshotOf(clients, rg, "data", desc.snapshotId, dataDisk));

      // An empty result is returned, not raised. A machine whose disks are already gone
      // genuinely has nothing to copy, and the caller records that honestly as a
      // snapshot row with no captured disks rather than inventing one. A disk that
      // exists but cannot be copied is a real ProvisioningError and propagates.
      return {
        disks,
        sizeBytes: disks.reduce((total, disk) => total + disk.sizeBytes, 0),
      } satisfies SnapshotResult;
    }),

  archive: (machineId: string, _provider, externalId) =>
    Effect.gen(function* () {
      const clients = yield* getClients();
      const rg = config.azureMachinesResourceGroup;
      const { names } = yield* resolveVmNames(clients, rg, machineId, externalId);

      yield* tolerateAlreadyGone(
        runArm(() => clients.compute.virtualMachines.beginDeallocateAndWait(rg, names.vm)),
      );

      // Snapshotting used to happen right here, inline, with its results discarded.
      // It now belongs to `snapshot()` below, which `createSnapshot` calls BEFORE this
      // teardown and whose ids actually get written down. Archiving is teardown only.
      //
      // Ordering note for anyone moving this: the snapshot must come first. If teardown
      // failed after a successful snapshot you are left with a copy and a live machine,
      // which is recoverable; the reverse is not.

      // Teardown. Each delete tolerates only its OWN target being gone, and the
      // sequence always runs to the end: these five resources are independent, and
      // one missing NIC must never leave a public IP or a disk behind.
      yield* tolerateAlreadyGone(
        runArm(() => clients.compute.virtualMachines.beginDeleteAndWait(rg, names.vm)),
      );
      yield* tolerateAlreadyGone(
        runArm(() => clients.compute.disks.beginDeleteAndWait(rg, names.osDisk)),
      );
      yield* tolerateAlreadyGone(
        runArm(() => clients.compute.disks.beginDeleteAndWait(rg, names.dataDisk)),
      );
      yield* tolerateAlreadyGone(
        runArm(() => clients.network.networkInterfaces.beginDeleteAndWait(rg, names.nic)),
      );
      yield* tolerateAlreadyGone(
        runArm(() => clients.network.publicIPAddresses.beginDeleteAndWait(rg, names.pip)),
      );

      return { machineId, state: "archived", externalId: null } satisfies MachineStatus;
    }),

  reconcile: (machineId: string, _provider, externalId) =>
    Effect.gen(function* () {
      const clients = yield* getClients();
      const rg = config.azureMachinesResourceGroup;
      const { names, resourceId } = yield* resolveVmNames(clients, rg, machineId, externalId);

      const view = yield* runArm(() => clients.compute.virtualMachines.instanceView(rg, names.vm));
      const powerState = view.statuses?.find((s) => s.code?.startsWith("PowerState/"))?.code;

      return {
        machineId,
        state: machineStateForPowerState(powerState),
        externalId: resourceId,
      } satisfies MachineStatus;
    }),

  reimage: (desc: ReimageDescriptor) =>
    Effect.gen(function* () {
      const imageReference = imageReferenceFor(desc.targetImage);
      if (!imageReference) {
        return yield* Effect.fail(
          new ProvisioningError({
            reason: "provider_error",
            cause: `Azure adapter only supports "ubuntu-XX.YY" images, got: ${desc.targetImage}`,
          }),
        );
      }
      if (!desc.region) {
        return yield* Effect.fail(
          new ProvisioningError({ reason: "provider_error", cause: "azure requires a region" }),
        );
      }
      const region = desc.region;
      const clients = yield* getClients();
      const rg = config.azureMachinesResourceGroup;
      // Reimage keeps the same logical machine's identity — the replacement
      // VM is created under the exact same names the old one had, resolved
      // the same way `archive`/`reconcile` do (see `resolveVmNames`), not a
      // freshly-minted one.
      const { names } = yield* resolveVmNames(clients, rg, desc.machineId, desc.externalId);

      // Delete the VM + its OS disk only — NIC, public IP, and (crucially)
      // the data disk survive. "An OS upgrade is: reimage, remount
      // persistent volume, reinstall declared packages" (docs/spec.md §2) —
      // this is the ARM-resource half of that; actually re-mounting
      // declared persistent paths onto the surviving disk is agent-side
      // work that doesn't exist anywhere in this codebase yet, out of scope
      // here.
      yield* runArm(() => clients.compute.virtualMachines.beginDeleteAndWait(rg, names.vm));
      yield* runArm(() => clients.compute.disks.beginDeleteAndWait(rg, names.osDisk));

      const nic = yield* runArm(() => clients.network.networkInterfaces.get(rg, names.nic));

      // A fresh VM = a fresh system-assigned identity, deliberately — see
      // ProvisioningService.ts's `reimage` doc comment ("mints a fresh
      // attestation identity"). The agent re-attests from scratch on boot.
      const vm = yield* runArm(() =>
        clients.compute.virtualMachines.beginCreateOrUpdateAndWait(rg, names.vm, {
          location: region,
          tags: { "cloudable-machine-id": desc.machineId, "cloudable-org-id": desc.orgId },
          identity: { type: "SystemAssigned" },
          hardwareProfile: { vmSize: desc.sizeSku },
          storageProfile: {
            imageReference,
            osDisk: {
              name: names.osDisk,
              createOption: "FromImage",
              managedDisk: { storageAccountType: "Standard_LRS" },
            },
            dataDisks: [
              {
                lun: DATA_DISK_LUN,
                createOption: "Attach",
                managedDisk: { id: dataDiskIdFor(clients, rg, names) },
              },
            ],
          },
          osProfile: {
            computerName: names.computerName,
            adminUsername: MACHINE_OS_USER,
            adminPassword: throwawayAdminPassword(),
            customData: cloudInitFor(
              {
                machineId: desc.machineId,
                orgId: desc.orgId,
                provider: "azure",
                region,
                sizeSku: desc.sizeSku,
              },
              DATA_DISK_LUN,
            ),
          },
          networkProfile: { networkInterfaces: [{ id: nic.id as string }] },
        }),
      );

      return {
        machineId: desc.machineId,
        state: "provisioning",
        externalId: vm.id ?? null,
      } satisfies MachineStatus;
    }),

  // Not this session's file — a concurrent change owns `restart`, left
  // exactly as found.
  restart: () =>
    Effect.fail(new ProvisioningError({ reason: "provider_error", cause: "not implemented" })),
};

export const AzureProvisioningServiceLive = Layer.succeed(ProvisioningServiceTag, service);
