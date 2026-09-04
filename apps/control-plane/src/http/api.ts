import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { EvidenceGroup } from "../evidence/api";
import { AccessGroup } from "./routes/access";
import { AgentProtocolGroup } from "./routes/agent-protocol";
import { ApprovalsGroup } from "./routes/approvals";
import { ArchiveGroup } from "./routes/archive";
import { CatalogGroup } from "./routes/catalog";
import { ComplianceGroup } from "./routes/compliance";
import { ConfigGroup } from "./routes/config";
import { ElevationsGroup } from "./routes/elevations";
import { IntegrationsGroup } from "./routes/integrations";
import { MachinesGroup } from "./routes/machines";
import { NotificationsGroup } from "./routes/notifications";
import { OffboardingGroup } from "./routes/offboarding";
import { OrganisationGroup } from "./routes/organisation";
import { PeopleGroup } from "./routes/people";
import { ProvisioningCapabilitiesGroup } from "./routes/provisioning-capabilities";
import { RestartGroup } from "./routes/restart";
import { TunnelGroup } from "./routes/tunnel";
import { TunnelSignalGroup } from "./routes/tunnel-signal";
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
  .add(AccessGroup)
  .add(PeopleGroup)
  .add(OrganisationGroup)
  .add(IntegrationsGroup)
  .add(TunnelSignalGroup)
  .add(TunnelGroup)
  .add(NotificationsGroup)
  .add(RestartGroup)
  .add(CatalogGroup)
  .add(ProvisioningCapabilitiesGroup) {}
// Feature units: import your HttpApiGroup and append `.add(YourGroup)` to the chain above.
// Never reorder existing `.add()` calls.
