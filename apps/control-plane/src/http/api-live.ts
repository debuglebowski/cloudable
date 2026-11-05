// ---------------------------------------------------------------------------
// The API: every endpoint group, wired to its handlers. Its own module so the
// server (`../server.ts`) and the route-level authorization test
// (`authz-matrix.test.ts`) run exactly the same handlers.
// ---------------------------------------------------------------------------
import { HttpApiBuilder } from "@effect/platform";
import { Layer } from "effect";
import { DbLive } from "../db/layer";
import { EvidenceLive } from "../evidence/handler";
import { Api } from "./api";
import { AccessLive } from "./handlers/access";
import { AgentProtocolLive } from "./handlers/agent-protocol";
import { ApprovalsLive } from "./handlers/approvals";
import { ArchiveLive } from "./handlers/archive";
import { AuthSsoStatusLive } from "./handlers/auth-sso-status";
import { CatalogLive } from "./handlers/catalog";
import { CliAuthLive } from "./handlers/cli-auth";
import { ComplianceLive } from "./handlers/compliance";
import { ConfigLive } from "./handlers/config";
import { ElevationsLive } from "./handlers/elevations";
import { HealthLive } from "./handlers/health";
import { IntegrationsLive } from "./handlers/integrations";
import { MachinesLive } from "./handlers/machines";
import { NotificationsLive } from "./handlers/notifications";
import { OffboardingHttpLive } from "./handlers/offboarding";
import { OrganisationLive } from "./handlers/organisation";
import { PeopleLive } from "./handlers/people";
import { ProvisioningCapabilitiesLive } from "./handlers/provisioning-capabilities";
import { RestartLive } from "./handlers/restart";
import { TunnelLive } from "./handlers/tunnel";
import { TunnelSignalLive } from "./handlers/tunnel-signal";
import { UpgradeLive } from "./handlers/upgrade";
import { VulnerabilityScanLive } from "./handlers/vulnerability-scan";

export const ApiLive = HttpApiBuilder.api(Api).pipe(
  Layer.provide(
    Layer.mergeAll(
      ElevationsLive,
      UpgradeLive,
      OffboardingHttpLive,
      HealthLive,
      MachinesLive,
      AgentProtocolLive,
      ApprovalsLive,
      ComplianceLive,
      EvidenceLive,
      ArchiveLive,
      ConfigLive,
      AccessLive,
      PeopleLive,
      OrganisationLive,
      IntegrationsLive,
      TunnelSignalLive,
      TunnelLive,
      NotificationsLive,
      RestartLive,
      CatalogLive,
      ProvisioningCapabilitiesLive,
      AuthSsoStatusLive,
      CliAuthLive,
      VulnerabilityScanLive,
    ),
  ),
  Layer.provide(DbLive),
);
