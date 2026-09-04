import { describe, expect, test } from "bun:test";
import { classifyAzureError, imageReferenceFor, namesFor } from "./ProvisioningService.azure";

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
