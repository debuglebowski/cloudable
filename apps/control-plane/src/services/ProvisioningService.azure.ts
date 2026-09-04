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
import { Effect, Layer } from "effect";
import { config } from "../config";
import {
  type MachineDescriptor,
  type MachineStatus,
  ProvisioningError,
  type ProvisioningService,
  ProvisioningServiceTag,
  type ReimageDescriptor,
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
export const UBUNTU_IMAGES: Record<string, { offer: string; sku: string }> = {
  "ubuntu-22.04": { offer: "0001-com-ubuntu-server-jammy", sku: "22_04-lts-gen2" },
  "ubuntu-24.04": { offer: "ubuntu-24_04-lts", sku: "server" },
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

/** Deterministic, Azure-name-safe resource names derived from machineId
 * alone — archive/reconcile/reimage never need to persist anything extra
 * to find a machine's resources back, same convention as
 * ProvisioningService.docker.ts's `containerName(machineId)`. */
export function namesFor(machineId: string) {
  const slug = `cldm${machineId.replace(/-/g, "")}`;
  return {
    vm: slug,
    nic: `${slug}-nic`,
    pip: `${slug}-pip`,
    osDisk: `${slug}-os`,
    dataDisk: `${slug}-data`,
    computerName: slug.slice(0, 15),
  };
}

/** Every binary this cloud-init installs is public (same posture as the
 * now-public GHCR control-plane image) — no token to inject. Unlike the
 * join-token adapters (docker/fake), the agent gets its own attestation
 * credential locally, from Azure IMDS, once it's running — nothing for the
 * control plane to hand it here. */
function cloudInitFor(desc: MachineDescriptor, dataDiskLun: number): string {
  const packages = (desc.packages ?? []).join(" ");
  const script = `#!/bin/bash
set -euo pipefail

DEVICE=$(readlink -f /dev/disk/azure/scsi1/lun${dataDiskLun})
MOUNT_POINT=/mnt/cloudable-data
if ! blkid "$DEVICE" >/dev/null 2>&1; then
  mkfs.ext4 -F "$DEVICE"
fi
mkdir -p "$MOUNT_POINT"
mount "$DEVICE" "$MOUNT_POINT"
echo "$DEVICE $MOUNT_POINT ext4 defaults,nofail 0 2" >> /etc/fstab

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

[Service]
ExecStart=/opt/cloudable/agent
Restart=always
Environment=CONTROL_PLANE_URL=${config.controlPlaneBaseUrl}
Environment=ATTESTATION_METHOD=managed_identity
Environment=CLOUDABLE_PACKAGES=${packages}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now cloudable-agent
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

/** Azure requires either an admin password or an SSH public key on every
 * Linux VM at creation — there is no "neither" option. A random, per-VM,
 * never-stored password satisfies that requirement; it's never logged,
 * returned, or reused, and the NSG Terraform attaches to the subnet
 * (infra/terraform/control-plane/main.tf) denies ALL inbound traffic
 * regardless — including port 22 — so nothing can ever attempt to use it.
 * Real access to a machine is exclusively via the tunnel daemon + SSH CA
 * (docs/access.md), never this. */
function throwawayAdminPassword(): string {
  return `Cldm-${crypto.randomUUID()}-${crypto.randomUUID()}`;
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
      const names = namesFor(desc.machineId);
      const tags = { "cloudable-machine-id": desc.machineId, "cloudable-org-id": desc.orgId };

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
              adminUsername: "cloudable",
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
    }),

  archive: (machineId: string, _provider) =>
    Effect.gen(function* () {
      const clients = yield* getClients();
      const names = namesFor(machineId);
      const rg = config.azureMachinesResourceGroup;

      yield* runArm(() => clients.compute.virtualMachines.get(rg, names.vm));
      yield* runArm(() => clients.compute.virtualMachines.beginDeallocateAndWait(rg, names.vm));

      // A snapshot's location must match its source disk's — fetch the disk
      // first rather than assuming it matches the machine's own region.
      const osDisk = yield* runArm(() => clients.compute.disks.get(rg, names.osDisk));

      // Real snapshot of the OS disk — its `diskSizeGB` is the real size an
      // eventual pricing-estimate wire-up would read, in place of
      // `PLACEHOLDER_SNAPSHOT_SIZE_BYTES` (domain/archive/pricing.ts). Not
      // wired up by this change — `MachineStatus` has no `sizeBytes` field
      // yet; that's a small, separate follow-up.
      yield* runArm(() =>
        clients.compute.snapshots.beginCreateOrUpdateAndWait(rg, `${names.osDisk}-snap`, {
          location: osDisk.location ?? "",
          creationData: {
            createOption: "Copy",
            sourceResourceId: osDisk.id as string,
          },
        }),
      );

      // No restore-side ARM code exists in this build at all
      // (docs/lifecycle.md: "adding one is out of this unit's file scope") —
      // the data disk buys nothing kept around, so it's deleted along with
      // everything else rather than orphaned.
      yield* runArm(() => clients.compute.virtualMachines.beginDeleteAndWait(rg, names.vm));
      yield* runArm(() => clients.compute.disks.beginDeleteAndWait(rg, names.osDisk));
      yield* runArm(() => clients.compute.disks.beginDeleteAndWait(rg, names.dataDisk));
      yield* runArm(() => clients.network.networkInterfaces.beginDeleteAndWait(rg, names.nic));
      yield* runArm(() => clients.network.publicIPAddresses.beginDeleteAndWait(rg, names.pip));

      return { machineId, state: "archived", externalId: null } satisfies MachineStatus;
    }),

  reconcile: (machineId: string, _provider) =>
    Effect.gen(function* () {
      const clients = yield* getClients();
      const names = namesFor(machineId);
      const rg = config.azureMachinesResourceGroup;

      const view = yield* runArm(() => clients.compute.virtualMachines.instanceView(rg, names.vm));
      const powerState = view.statuses?.find((s) => s.code?.startsWith("PowerState/"))?.code;

      return {
        machineId,
        state: powerState === "PowerState/running" ? "running" : "error",
        externalId: `/subscriptions/${clients.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${names.vm}`,
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
      const names = namesFor(desc.machineId);
      const rg = config.azureMachinesResourceGroup;

      yield* runArm(() => clients.compute.virtualMachines.get(rg, names.vm));

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
            adminUsername: "cloudable",
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
