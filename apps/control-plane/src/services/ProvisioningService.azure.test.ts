import { describe, expect, test } from "bun:test";
import { config } from "../config";
import {
  classifyAzureError,
  cloudInitFor,
  imageReferenceFor,
  namesFor,
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

  test("both binaries are downloaded from this control plane's own public base URL", () => {
    const script = decode();
    expect(script).toContain(
      `curl -fsSL "${config.controlPlaneBaseUrl}/_internal/binaries/cloudable-agent-linux-$ARCH"`,
    );
    expect(script).toContain(
      `curl -fsSL "${config.controlPlaneBaseUrl}/_internal/binaries/cloudable-tunnel-daemon-linux-$ARCH"`,
    );
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
