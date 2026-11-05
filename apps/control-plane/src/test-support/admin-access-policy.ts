import { afterAll, beforeAll } from "bun:test";
import { config } from "../config";

/**
 * Production pins `ADMIN_ACCESS_POLICY` to `never`, which is also the default, so no elevation
 * opens anything. Tests of the elevation machinery itself call this inside their `describe` to
 * run under a deployment that allows it, and put the value back afterwards.
 */
export const useAdminAccessPolicy = (policy: "never" | "with_approval" | "always"): void => {
  const mutable = config as { adminAccessPolicy: typeof policy };
  let previous: typeof policy;
  beforeAll(() => {
    previous = mutable.adminAccessPolicy;
    mutable.adminAccessPolicy = policy;
  });
  afterAll(() => {
    mutable.adminAccessPolicy = previous;
  });
};

/** Sets the pinned policy for the rest of a test. Pair with `useAdminAccessPolicy` (or an
 * `afterEach`) so it does not leak into the next file. */
export const pinAdminAccessPolicyForTest = (policy: "never" | "with_approval" | "always"): void => {
  (config as { adminAccessPolicy: typeof policy }).adminAccessPolicy = policy;
};
