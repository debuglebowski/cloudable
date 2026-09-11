import { describe, expect, it } from "bun:test";
import { safeRedirectTarget, ssoErrorFromSearch } from "./redirect-target";

describe("safeRedirectTarget", () => {
  it("returns the path for a normally-encoded param", () => {
    expect(safeRedirectTarget("?redirect=%2Fintegrations")).toBe("/integrations");
  });

  it("keeps a query string on the target", () => {
    expect(safeRedirectTarget("?redirect=%2Fmachines%3Ftab%3Ddrift")).toBe("/machines?tab=drift");
  });

  it("falls back to / when the param is absent", () => {
    expect(safeRedirectTarget("")).toBe("/");
    expect(safeRedirectTarget("?other=1")).toBe("/");
  });

  /**
   * The real regression: a double-encoded param arrives as "%2Fintegrations"
   * after URLSearchParams decodes once. Concatenated onto the origin that
   * produced "https://host%2Fintegrations", which BetterAuth rejected as an
   * invalid callbackURL.
   */
  it("does not produce a mangled hostname from a double-encoded param", () => {
    const target = safeRedirectTarget("?redirect=%252Fintegrations");
    expect(target.startsWith("/")).toBe(true);
    expect(new URL(`https://console.example.com${target}`).hostname).toBe("console.example.com");
  });

  it("refuses protocol-relative values that would leave the origin", () => {
    expect(safeRedirectTarget("?redirect=%2F%2Fevil.com")).toBe("/");
    expect(safeRedirectTarget("?redirect=https%3A%2F%2Fevil.com")).toBe("/");
    expect(safeRedirectTarget("?redirect=%2F%5Cevil.com")).toBe("/");
  });
});

describe("ssoErrorFromSearch", () => {
  it("returns null when there was no failure", () => {
    expect(ssoErrorFromSearch("?redirect=%2F")).toBeNull();
  });

  it("returns the code on its own", () => {
    expect(ssoErrorFromSearch("?error=account_not_linked")).toBe("account_not_linked");
  });

  it("includes the description when the plugin supplies one", () => {
    expect(ssoErrorFromSearch("?error=invalid_saml&error_description=bad%20signature")).toBe(
      "invalid_saml: bad signature",
    );
  });
});
