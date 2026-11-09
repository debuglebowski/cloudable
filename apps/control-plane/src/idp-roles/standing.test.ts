import { describe, expect, it } from "bun:test";
import type { IdpRolesConfig } from "./config";
import { checkStanding, roleEvidenceDeadline } from "./standing";

const managed: IdpRolesConfig = {
  enabled: true,
  claim: "roles",
  mapping: { A: ["admin"] },
  intervalSec: 3600,
  fingerprint: "f",
};
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const person = (over: Partial<Parameters<typeof checkStanding>[0]> = {}) => ({
  active: true,
  credentialsRevokedAt: null,
  idpRolesVerifiedAt: new Date(T0),
  ...over,
});

describe("checkStanding", () => {
  it("mode off: only active and revocation count, as before", () => {
    expect(
      checkStanding(person({ idpRolesVerifiedAt: null }), T0, T0 + 10 * 3600_000, null),
    ).toBeNull();
    expect(checkStanding(person({ active: false }), T0, T0, null)).toBe("deactivated");
    expect(checkStanding(person({ credentialsRevokedAt: new Date(T0) }), T0, T0, null)).toBe(
      "credentials_revoked",
    );
    expect(
      checkStanding(person({ credentialsRevokedAt: new Date(T0) }), T0 + 1, T0, null),
    ).toBeNull();
  });

  it("mode on: role evidence must be younger than the interval; the deadline itself is stale", () => {
    expect(checkStanding(person(), T0, T0 + 3599_000, managed)).toBeNull();
    expect(checkStanding(person(), T0, T0 + 3600_000, managed)).toBe(
      "idp_reauthentication_required",
    );
    expect(checkStanding(person({ idpRolesVerifiedAt: null }), T0, T0, managed)).toBe(
      "idp_reauthentication_required",
    );
    // Evidence from the future is not evidence.
    expect(
      checkStanding(person({ idpRolesVerifiedAt: new Date(T0 + 60_000) }), T0, T0, managed),
    ).toBe("idp_reauthentication_required");
  });

  it("revocation is checked before freshness", () => {
    expect(
      checkStanding(person({ credentialsRevokedAt: new Date(T0 + 1) }), T0, T0 + 2, managed),
    ).toBe("credentials_revoked");
  });

  it("gives the deadline that caps derived credentials", () => {
    expect(roleEvidenceDeadline(person(), managed)?.getTime()).toBe(T0 + 3600_000);
    expect(roleEvidenceDeadline(person({ idpRolesVerifiedAt: null }), managed)).toBeNull();
  });
});
