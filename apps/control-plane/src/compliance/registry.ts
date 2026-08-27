import type { ComplianceCheck } from "../domain/compliance/types";
import { activeOwnerCheck } from "./checks/active-owner";
import { noUndeclaredSoftwareCheck } from "./checks/no-undeclared-software";

// Feature units append their own check to this array — additive only, never reorder.
export const COMPLIANCE_CHECKS: ComplianceCheck[] = [
  // unit 7 appends the "access revoked on offboarding" check here
  activeOwnerCheck,
  noUndeclaredSoftwareCheck,
  // unit 9 appends "elevated access approved" + "retention honoured"
  // unit 10 appends "machines are reporting"
];
