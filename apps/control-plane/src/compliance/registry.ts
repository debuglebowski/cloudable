import type { ComplianceCheck } from "../domain/compliance/types";
import { accessRevokedOnOffboardingCheck } from "./checks/access-revoked";
import { activeOwnerCheck } from "./checks/active-owner";
import { elevatedAccessApprovedCheck } from "./checks/elevated-access-approved";
import { machinesReportingCheck } from "./checks/machines-reporting";
import { noUndeclaredSoftwareCheck } from "./checks/no-undeclared-software";
import { retentionHonouredCheck } from "./checks/retention-honoured";

// Feature units append their own check to this array — additive only, never reorder.
export const COMPLIANCE_CHECKS: ComplianceCheck[] = [
  accessRevokedOnOffboardingCheck,
  activeOwnerCheck,
  noUndeclaredSoftwareCheck,
  elevatedAccessApprovedCheck,
  retentionHonouredCheck,
  machinesReportingCheck,
];
