import { describe, expect, test } from "bun:test";
import { config } from "../config";
import {
  classifyAzureError,
  cloudInitFor,
  imageReferenceFor,
  machineStateForPowerState,
  namesFor,
  parseVmNameFromResourceId,
  throwawayAdminPassword,
} from "./ProvisioningService.azure";

describe("imageReferenceFor", () => {
  test("maps known Ubuntu versions to Canonical gallery images", () => {
    expect(imageReferenceFor("ubuntu-22.04")).toEqual({
      publisher: "Canonical",
      offer: "0001-com-ubuntu-server-jammy",
      sku: "22_04-lts-gen2",
      version: "latest",
    });
    expect(imageReferenceFor("ubuntu-24.04")).toEqual({
      publisher: "Canonical",
      offer: "ubuntu-24_04-lts",
      sku: "server",
      version: "latest",
    });
  });

  test("defaults to ubuntu-22.04 when no image is given", () => {
    expect(imageReferenceFor(undefined)).toEqual(imageReferenceFor("ubuntu-22.04"));
  });

  test("rejects an unsupported image rather than guessing", () => {
    expect(imageReferenceFor("windows-2022")).toBeNull();
    expect(imageReferenceFor("ubuntu-20.04")).toBeNull();
  });
});

describe("namesFor", () => {
  test("derives deterministic, Azure-name-safe resource names from a machineId", () => {
    const machineId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const names = namesFor(machineId);
    expect(names.vm).toBe("cldm3fa85f6457174562b3fc2c963f66afa6");
    expect(names.nic).toBe(`${names.vm}-nic`);
    expect(names.pip).toBe(`${names.vm}-pip`);
    expect(names.osDisk).toBe(`${names.vm}-os`);
    expect(names.dataDisk).toBe(`${names.vm}-data`);
    // Azure Linux computerName limit.
    expect(names.computerName.length).toBeLessThanOrEqual(15);
  });

  test("is a pure function of machineId — same input, same names", () => {
    const machineId = "11111111-2222-3333-4444-555555555555";
    expect(namesFor(machineId)).toEqual(namesFor(machineId));
  });

  test("prefixes a sanitized, human-readable slug when a name is given", () => {
    const machineId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const names = namesFor(machineId, "Web Server 01!");
    // Only the first 12 of the id's 32 hex chars are used once a slug is
    // present — see namesFor's own doc comment for why that's still
    // collision-safe at any real scale.
    expect(names.vm).toBe("cldm-web-server-01-3fa85f645717");
    expect(names.nic).toBe(`${names.vm}-nic`);
    expect(names.pip).toBe(`${names.vm}-pip`);
    expect(names.osDisk).toBe(`${names.vm}-os`);
    expect(names.dataDisk).toBe(`${names.vm}-data`);
    expect(names.computerName).toBe(names.vm.slice(0, 15));
  });

  test("caps an overly long name so the VM name stays well under Azure's 64-char limit", () => {
    const machineId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const longName = "a".repeat(80);
    const names = namesFor(machineId, longName);
    expect(names.vm.length).toBeLessThanOrEqual(50);
    expect(names.vm).toBe(`cldm-${"a".repeat(32)}-3fa85f645717`);
  });

  test("falls back to the id-only scheme when a name sanitizes to nothing", () => {
    const machineId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(namesFor(machineId, "日本語")).toEqual(namesFor(machineId));
    expect(namesFor(machineId, "!!!")).toEqual(namesFor(machineId));
  });

  test("falls back to the id-only scheme when no name is given at all", () => {
    const machineId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    expect(namesFor(machineId, undefined)).toEqual(namesFor(machineId));
  });
});

describe("parseVmNameFromResourceId", () => {
  test("extracts the VM name from a real ARM resource id", () => {
    const id =
      "/subscriptions/abc-123/resourceGroups/rg-cloudable-managed/providers/Microsoft.Compute/virtualMachines/cldm-web-server-01-3fa85f645717";
    expect(parseVmNameFromResourceId(id)).toBe("cldm-web-server-01-3fa85f645717");
  });

  test("is case-insensitive on the resource-type segment", () => {
    // Azure resource ids are case-insensitive by convention; ARM sometimes
    // echoes them back with different casing than what was requested.
    const id =
      "/subscriptions/abc/resourceGroups/rg/providers/microsoft.compute/VIRTUALMACHINES/my-vm";
    expect(parseVmNameFromResourceId(id)).toBe("my-vm");
  });

  test("returns null for a trailing slash with no name", () => {
    const id = "/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/";
    expect(parseVmNameFromResourceId(id)).toBeNull();
  });

  test("returns null for an id naming a different resource type", () => {
    const id = "/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Compute/disks/my-disk";
    expect(parseVmNameFromResourceId(id)).toBeNull();
  });

  test("returns null for garbage input", () => {
    expect(parseVmNameFromResourceId("not-a-resource-id")).toBeNull();
    expect(parseVmNameFromResourceId("")).toBeNull();
  });
});

describe("cloudInitFor", () => {
  const desc = {
    machineId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    orgId: "org-1",
    provider: "azure" as const,
    region: "eastus",
    sizeSku: "Standard_B2s",
    image: "ubuntu-24.04",
    packages: ["docker"],
  };

  const decode = () => Buffer.from(cloudInitFor(desc, 0), "base64").toString("utf-8");

  test("installs and enables systemd units for BOTH the agent and the tunnel daemon", () => {
    // Regression test: an earlier version of this script downloaded the
    // tunnel-daemon binary but never created a systemd unit for it at all —
    // it sat on disk, executable, never started, so the web terminal / SSH
    // session-attach path silently never worked on a real machine.
    const script = decode();
    expect(script).toContain("cat > /etc/systemd/system/cloudable-agent.service");
    expect(script).toContain("cat > /etc/systemd/system/cloudable-tunnel-daemon.service");
    expect(script).toContain("ExecStart=/opt/cloudable/agent");
    expect(script).toContain("ExecStart=/opt/cloudable/tunnel-daemon");
    expect(script).toContain("systemctl enable --now cloudable-agent");
    expect(script).toContain("systemctl enable --now cloudable-tunnel-daemon");
  });

  // Regression: both units were `Restart=always` with no override, so
  // systemd's default burst limit (5 crashes in 10s) permanently stopped
  // them after any sustained boot-time failure (e.g. the attestation bug
  // this same session fixed) — no further retries, ever, without manual
  // intervention. `StartLimitIntervalSec=0` disables that permanent-death
  // behavior; a daemon whose only job is "keep trying to phone home" should
  // never stop trying.
  test("both units disable the restart burst limit so a sustained boot failure can't permanently kill them", () => {
    const script = decode();
    const unitBlocks = script.split(/(?=\[Unit\])/).filter((block) => block.includes("[Unit]"));
    expect(unitBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of unitBlocks) {
      expect(block).toContain("StartLimitIntervalSec=0");
    }
  });

  test("both binaries are downloaded from this control plane's own public base URL", () => {
    const script = decode();
    expect(script).toContain(
      `curl -fsSL "${config.controlPlaneBaseUrl}/_internal/binaries/cloudable-agent-linux-$ARCH"`,
    );
    expect(script).toContain(
      `curl -fsSL "${config.controlPlaneBaseUrl}/_internal/binaries/cloudable-tunnel-daemon-linux-$ARCH"`,
    );
  });

  // ---------------------------------------------------------------------------
  // The data-disk section. Before these, nothing in this file asserted anything
  // about it at all — not the mount point, not the fstab line, not the `lun`
  // parameter, which was untested end to end.
  //
  // What this level of test CANNOT catch, stated plainly so nobody mistakes a green
  // run for a working machine: these are substring assertions on a base64-decoded
  // string. They prove the TEXT, never the BEHAVIOUR. They cannot tell you whether
  // the mount succeeds, whether cloud-init really runs scripts-user after
  // users-groups on the image you boot, whether systemd really orders home.mount
  // before the tunnel daemon, or anything whatsoever about the reimage path — the
  // second run of this script against an already-populated disk, which is where the
  // real risk lives. Only booting a real VM and reimaging it covers those.
  // ---------------------------------------------------------------------------

  test("REGRESSION: /home is on the data disk, and the write-only mount point is gone", () => {
    // The bug this whole section exists for: /home/cloudable lived on the OS disk,
    // which `reimage` deletes, while the data disk was formatted, mounted at
    // /mnt/cloudable-data, and read by nothing in the entire repo. An upgrade
    // destroyed the person's work and preserved an empty volume. Production hit it
    // on 2026-09-14. If /mnt/cloudable-data ever comes back as a mount point, this
    // fails.
    const script = decode();
    expect(script).not.toContain("/mnt/cloudable-data");
    expect(script).toContain(" /home ext4 ");
    expect(script).toContain("mount /home");
  });

  test("the generated script is valid bash", () => {
    // The only assertion here that catches a real defect rather than a substring.
    // It also catches template-literal accidents: this script lives inside a TS
    // backtick literal, so a stray ${...} or a backslash that should have been
    // escaped usually produces something syntactically broken.
    const result = Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(decode()) });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("the data disk LUN reaches the device path", () => {
    // `dataDiskLun` was a parameter no test ever exercised.
    const script = Buffer.from(cloudInitFor(desc, 3), "base64").toString("utf-8");
    expect(script).toContain("/dev/disk/azure/scsi1/lun3");
  });

  test("fstab mounts by UUID, never by the /dev/sdX readlink resolves to", () => {
    // The previous version wrote `$DEVICE` — the output of `readlink -f`, i.e.
    // /dev/sdc. Azure SCSI letters are not stable across reboots, so that entry
    // could mount nothing or mount the wrong disk, and `nofail` made it silent.
    const script = decode();
    expect(script).toContain("blkid -s UUID -o value");
    expect(script).toContain('echo "UUID=$DISK_UUID /home ext4 defaults,nofail');
    expect(script).not.toMatch(/echo "\$DEVICE [^\n]*fstab/);
  });

  test("the mount stays nofail, and the ordering is enforced unit-side instead", () => {
    // Locking in a decision that looks wrong at a glance. Dropping `nofail` to close
    // the boot race would take local-fs.target into emergency mode when the disk is
    // genuinely missing — and there is no way back into one of these machines: no
    // inbound access by design (invariant 7), and the serial console wants an admin
    // password throwawayAdminPassword() deliberately discards. So nofail stays and
    // RequiresMountsFor on the daemon does the ordering.
    const script = decode();
    expect(script).toContain("nofail");
    expect(script).toContain("x-systemd.device-timeout=30s");
  });

  test("only the tunnel daemon waits for /home, deliberately not the agent", () => {
    // Asymmetric on purpose. Every session the daemon opens is `su - cloudable`, so
    // starting before /home is mounted hands the person the wrong home. The agent
    // runs as root from /opt and never touches /home; making it wait would mean a
    // missing disk also makes the machine invisible to the control plane and
    // un-remediable by reimage. Encoded here so nobody "fixes the inconsistency".
    const script = decode();
    const unitBlocks = script.split(/(?=\[Unit\])/).filter((block) => block.includes("[Unit]"));
    const daemon = unitBlocks.find((b) => b.includes("ExecStart=/opt/cloudable/tunnel-daemon"));
    const agent = unitBlocks.find((b) => b.includes("ExecStart=/opt/cloudable/agent"));
    expect(daemon).toContain("RequiresMountsFor=/home");
    expect(agent).not.toContain("RequiresMountsFor");
  });

  test("the disk is set up before the units that depend on it are started", () => {
    // Catches a future edit that hoists the unit setup above the disk section, which
    // would silently restore the original race with no other visible symptom.
    const script = decode();
    expect(script.indexOf("mount /home")).toBeLessThan(
      script.indexOf("systemctl enable --now cloudable-tunnel-daemon"),
    );
    expect(script.indexOf("/etc/fstab")).toBeLessThan(script.indexOf("systemctl daemon-reload"));
  });

  test("mkfs is guarded, runs at most once, and nothing recursively deletes /home", () => {
    // mkfs is the one destructive command in the script. It must stay behind the
    // blkid guard: a disk that already holds a home always has a signature, so a
    // reimage can never reach it. And a boot script must never carry an rm -rf
    // anywhere near /home — the OS-disk home is renamed aside, never deleted,
    // because it is the only copy of whatever was there.
    const script = decode();
    expect(script.match(/mkfs\.ext4/g)).toHaveLength(1);
    expect(script).toContain('if ! blkid "$DEVICE"');
    expect(script).not.toMatch(/^\s*rm -rf[^\n]*\/home/m);
    expect(script).toContain('mv /home "$OSDISK_HOME"');
  });

  test("the uid remedy is scoped, never a blanket chown of the whole home", () => {
    // A reimaged VM creates the account from scratch and can land on a different
    // uid. The remedy moves the ACCOUNT to the files (usermod, O(1)) and only falls
    // back to a chown scoped with --from, so files deliberately owned by root or a
    // service inside the home survive. An unconditional chown -R on every boot would
    // be O(files) on a 64 GiB volume in front of the daemon that serves sessions,
    // would clear setuid bits, and would destroy ownership nothing can reconstruct.
    const script = decode();
    expect(script).toContain('usermod -u "$WANT_UID"');
    expect(script).toContain("chown -R --from=");
    expect(script).not.toMatch(/^\s*chown -R (?!--from)[^\n]*\/home/m);
  });

  test("the seeded marker is written only after sync", () => {
    // Crash safety: a copy interrupted half way must leave no marker, so the next
    // boot seeds again rather than mounting a half-populated home and declaring
    // victory.
    const script = decode();
    expect(script.indexOf("sync")).toBeLessThan(script.indexOf('> "/home/$MARKER"'));
  });
});

describe("throwawayAdminPassword", () => {
  // Regression: the original `"Cldm-" + uuid + "-" + uuid` was 78 characters —
  // over Azure's 72-character max for a Linux VM admin password. This failed VM
  // creation live with `provider_error: The supplied password must be between
  // 6-72 characters long...` on every request that got far enough in Azure's
  // validation pipeline to reach this field (most were rejected earlier, on
  // SKU/region compatibility, until this session's other fixes cleared that
  // path). Checked across many calls, not just one, since the UUID content is
  // random — length must hold for every possible UUID, not just the sampled one.
  test("always falls within Azure's 6-72 character bounds for a Linux VM admin password", () => {
    for (let i = 0; i < 200; i++) {
      const password = throwawayAdminPassword();
      expect(password.length).toBeGreaterThanOrEqual(6);
      expect(password.length).toBeLessThanOrEqual(72);
    }
  });

  // Azure requires at least 3 of: uppercase, lowercase, digit, special character,
  // no control characters. Checked deterministically via the fixed "Cldm-" prefix
  // and a v4 UUID's fixed version nibble, not by sampling and hoping.
  test("always satisfies at least 3 of Azure's password complexity categories", () => {
    for (let i = 0; i < 200; i++) {
      const password = throwawayAdminPassword();
      const categories = [
        /[A-Z]/.test(password),
        /[a-z]/.test(password),
        /[0-9]/.test(password),
        /[^A-Za-z0-9]/.test(password),
      ].filter(Boolean).length;
      expect(categories).toBeGreaterThanOrEqual(3);
    }
  });

  test("is different on every call — never reused across machines", () => {
    expect(throwawayAdminPassword()).not.toBe(throwawayAdminPassword());
  });
});

describe("classifyAzureError", () => {
  test("maps a 404 to not_found", () => {
    expect(classifyAzureError({ statusCode: 404 })).toBe("not_found");
  });

  test("maps 409 and 429 to quota_exceeded", () => {
    expect(classifyAzureError({ statusCode: 409 })).toBe("quota_exceeded");
    expect(classifyAzureError({ statusCode: 429 })).toBe("quota_exceeded");
  });

  test("falls back to provider_error for anything else", () => {
    expect(classifyAzureError({ statusCode: 500 })).toBe("provider_error");
    expect(classifyAzureError(new Error("boom"))).toBe("provider_error");
    expect(classifyAzureError(undefined)).toBe("provider_error");
  });
});

describe("machineStateForPowerState", () => {
  test("a machine that is off is stopped, not an error", () => {
    expect(machineStateForPowerState("PowerState/deallocated")).toBe("stopped");
    expect(machineStateForPowerState("PowerState/stopped")).toBe("stopped");
  });

  test("running is running", () => {
    expect(machineStateForPowerState("PowerState/running")).toBe("running");
  });

  test("a machine mid-transition is not settled yet, not broken", () => {
    expect(machineStateForPowerState("PowerState/starting")).toBe("provisioning");
    expect(machineStateForPowerState("PowerState/stopping")).toBe("provisioning");
    expect(machineStateForPowerState("PowerState/deallocating")).toBe("provisioning");
  });

  test("no power state at all means the VM never came up", () => {
    expect(machineStateForPowerState(undefined)).toBe("error");
    expect(machineStateForPowerState("PowerState/unknown")).toBe("error");
  });
});
