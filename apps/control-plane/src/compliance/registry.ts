import type { ComplianceCheck } from "../domain/compliance/types";
import { machinesReportingCheck } from "./checks/machines-reporting";

// Feature units append their own check to this array — additive only, never reorder.
export const COMPLIANCE_CHECKS: ComplianceCheck[] = [
  // unit 7 appends the "access revoked on offboarding" check here
  // unit 8 appends "active owner" + "no undeclared software"
  // unit 9 appends "elevated access approved" + "retention honoured"
  machinesReportingCheck,
];
