import { describe, expect, test } from "bun:test";
import { EXIT } from "./errors";
import { ApiError } from "./http-client";

describe("ApiError messages for roles from the identity provider", () => {
  test("a stale role tells the person to sign in again", () => {
    const error = new ApiError(401, {
      _tag: "AuthenticationRequired",
      reason: "idp_reauthentication_required",
    });
    expect(error.message).toContain("cloudable login");
    expect(error.exitCode).toBe(EXIT.unauthenticated);
  });

  test("a refused role change shows the shared message and exits as a conflict", () => {
    const error = new ApiError(409, {
      _tag: "RolesManagedByIdpError",
      code: "ROLES_MANAGED_BY_IDP",
      message: "Roles are managed by your identity provider.",
    });
    expect(error.message).toBe("Roles are managed by your identity provider.");
    expect(error.exitCode).toBe(EXIT.conflict);
  });
});
