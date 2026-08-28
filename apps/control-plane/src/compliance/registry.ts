import type { ComplianceCheck } from "../domain/compliance/types";
import { accessRevokedOnOffboardingCheck } from "./checks/access-revoked";
import { activeOwnerCheck } from "./checks/active-owner";
import { noUndeclaredSoftwareCheck } from "./checks/no-undeclared-software";

// Feature units append their own check to this array — additive only, never reorder.
export const COMPLIANCE_CHECKS: ComplianceCheck[] = [
  accessRevokedOnOffboardingCheck,
  activeOwnerCheck,
  noUndeclaredSoftwareCheck,
  // unit 9 appends "elevated access approved" + "retention honoured"
  // unit 10 appends "machines are reporting"
];
