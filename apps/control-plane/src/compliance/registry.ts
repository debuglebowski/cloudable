import type { ComplianceCheck } from "../domain/compliance/types";

// Feature units append their own check to this array — additive only, never reorder.
export const COMPLIANCE_CHECKS: ComplianceCheck[] = [
  // unit 7 appends the "access revoked on offboarding" check here
  // unit 8 appends "active owner" + "no undeclared software"
  // unit 9 appends "elevated access approved" + "retention honoured"
  // unit 10 appends "machines are reporting"
];
