import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { EvidenceGroup } from "../evidence/api";
import { AccessGroup } from "./routes/access";
import { AgentProtocolGroup } from "./routes/agent-protocol";
import { ApprovalsGroup } from "./routes/approvals";
import { ArchiveGroup } from "./routes/archive";
import { ComplianceGroup } from "./routes/compliance";
import { ConfigGroup } from "./routes/config";
import { ElevationsGroup } from "./routes/elevations";
import { FederationGroup } from "./routes/federation";
import { MachinesGroup } from "./routes/machines";
import { OffboardingGroup } from "./routes/offboarding";
import { UpgradeGroup } from "./routes/upgrade";

const HealthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("check", "/api/v1/health").addSuccess(
    Schema.Struct({ status: Schema.Literal("ok") }),
  ),
);

export class Api extends HttpApi.make("cloudable")
  .add(HealthGroup)
  .add(MachinesGroup)
  .add(AgentProtocolGroup)
  .add(ApprovalsGroup)
  .add(ComplianceGroup)
  .add(EvidenceGroup)
  .add(ArchiveGroup)
  .add(OffboardingGroup)
  .add(UpgradeGroup)
  .add(ElevationsGroup)
  .add(ConfigGroup)
  .add(FederationGroup)
  .add(AccessGroup) {}
// Feature units: import your HttpApiGroup and append `.add(YourGroup)` to the chain above.
// Never reorder existing `.add()` calls.
