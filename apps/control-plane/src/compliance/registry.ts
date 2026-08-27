import type { ComplianceCheck } from "../domain/compliance/types";
import { accessRevokedOnOffboardingCheck } from "./checks/access-revoked";

// Feature units append their own check to this array — additive only, never reorder.
export const COMPLIANCE_CHECKS: ComplianceCheck[] = [
  accessRevokedOnOffboardingCheck,
  // unit 8 appends "active owner" + "no undeclared software"
  // unit 9 appends "elevated access approved" + "retention honoured"
  // unit 10 appends "machines are reporting"
];
