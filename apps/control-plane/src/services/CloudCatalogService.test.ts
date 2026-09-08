import { describe, expect, test } from "bun:test";
import { isGen2Capable, isScheduledForRetirement } from "./CloudCatalogService";

describe("isGen2Capable", () => {
  test("accepts a size whose HyperVGenerations includes V2", () => {
    expect(isGen2Capable({ capabilities: [{ name: "HyperVGenerations", value: "V1,V2" }] })).toBe(
      true,
    );
    expect(isGen2Capable({ capabilities: [{ name: "HyperVGenerations", value: "V2" }] })).toBe(
      true,
    );
  });

  test("rejects a size stuck on V1 — seen live: Standard_A4m_v2 failed VM creation against this deployment's (Gen2-only) images with exactly this mismatch", () => {
    expect(isGen2Capable({ capabilities: [{ name: "HyperVGenerations", value: "V1" }] })).toBe(
      false,
    );
  });

  test("treats a missing HyperVGenerations capability as not Gen2-capable, not as unknown", () => {
    expect(isGen2Capable({ capabilities: [] })).toBe(false);
    expect(isGen2Capable({})).toBe(false);
  });
});

describe("isScheduledForRetirement", () => {
  test("flags a size Azure has announced it will retire, regardless of the actual date", () => {
    expect(
      isScheduledForRetirement({
        capabilities: [{ name: "RetirementDateUtc", value: "11/16/2028" }],
      }),
    ).toBe(true);
  });

  test("a size with no RetirementDateUtc capability is not flagged", () => {
    expect(isScheduledForRetirement({ capabilities: [{ name: "vCPUs", value: "4" }] })).toBe(false);
    expect(isScheduledForRetirement({ capabilities: [] })).toBe(false);
    expect(isScheduledForRetirement({})).toBe(false);
  });
});
