// ---------------------------------------------------------------------------
// Command path → implementation. A table rather than a switch so a test can
// check it against the registry in `help.ts`: a command that help advertises
// but nothing implements, or an implementation help never mentions, fails
// `dispatch.test.ts` instead of surfacing as a runtime error for whoever
// typed it.
//
// Imports stay dynamic so a command's dependencies — and the env vars they
// read — load only when that command runs.
// ---------------------------------------------------------------------------
export type CommandHandler = (rest: ReadonlyArray<string>) => void | Promise<void>;

export const HANDLERS: Readonly<Record<string, CommandHandler>> = {
  login: async (rest) => {
    const { runLoginCommand } = await import("./login");
    await runLoginCommand(rest);
  },
  connect: async (rest) => {
    const { runConnectCommand } = await import("./connect");
    await runConnectCommand(rest);
  },

  logout: async () => {
    const { runLogoutCommand } = await import("./auth");
    runLogoutCommand();
  },
  whoami: async (rest) => {
    const { runWhoamiCommand } = await import("./auth");
    await runWhoamiCommand(rest);
  },

  "machines list": async (rest) => {
    const { runMachinesListCommand } = await import("./machines");
    await runMachinesListCommand(rest);
  },
  "machines get": async (rest) => {
    const { runMachinesGetCommand } = await import("./machines");
    await runMachinesGetCommand(rest);
  },
  "machines create": async (rest) => {
    const { runMachinesCreateCommand } = await import("./machines");
    await runMachinesCreateCommand(rest);
  },
  "machines restart": async (rest) => {
    const { runMachinesRestartCommand } = await import("./machines");
    await runMachinesRestartCommand(rest);
  },
  "machines upgrade": async (rest) => {
    const { runMachinesUpgradeCommand } = await import("./machines");
    await runMachinesUpgradeCommand(rest);
  },
  "machines archive": async (rest) => {
    const { runMachinesArchiveCommand } = await import("./machines");
    await runMachinesArchiveCommand(rest);
  },
  "machines packages list": async (rest) => {
    const { runMachinesPackagesListCommand } = await import("./machines");
    await runMachinesPackagesListCommand(rest);
  },
  "machines packages set": async (rest) => {
    const { runMachinesPackagesSetCommand } = await import("./machines");
    await runMachinesPackagesSetCommand(rest);
  },

  "sessions list": async (rest) => {
    const { runSessionsListCommand } = await import("./access");
    await runSessionsListCommand(rest);
  },
  "sessions end": async (rest) => {
    const { runSessionsEndCommand } = await import("./access");
    await runSessionsEndCommand(rest);
  },
  "certs list": async (rest) => {
    const { runCertsListCommand } = await import("./access");
    await runCertsListCommand(rest);
  },
  "certs revoke": async (rest) => {
    const { runCertsRevokeCommand } = await import("./access");
    await runCertsRevokeCommand(rest);
  },

  "elevation request": async (rest) => {
    const { runElevationRequestCommand } = await import("./elevations");
    await runElevationRequestCommand(rest);
  },
  "elevation list": async (rest) => {
    const { runElevationListCommand } = await import("./elevations");
    await runElevationListCommand(rest);
  },
  "elevation get": async (rest) => {
    const { runElevationGetCommand } = await import("./elevations");
    await runElevationGetCommand(rest);
  },
  "elevation sync": async (rest) => {
    const { runElevationSyncCommand } = await import("./elevations");
    await runElevationSyncCommand(rest);
  },
  "elevation expire": async (rest) => {
    const { runElevationExpireCommand } = await import("./elevations");
    await runElevationExpireCommand(rest);
  },

  "snapshots list": async (rest) => {
    const { runSnapshotsListCommand } = await import("./snapshots");
    await runSnapshotsListCommand(rest);
  },
  "snapshots get": async (rest) => {
    const { runSnapshotsGetCommand } = await import("./snapshots");
    await runSnapshotsGetCommand(rest);
  },
  "snapshots cost": async (rest) => {
    const { runSnapshotsCostCommand } = await import("./snapshots");
    await runSnapshotsCostCommand(rest);
  },
  "snapshots ls": async (rest) => {
    const { runSnapshotsLsCommand } = await import("./snapshots");
    await runSnapshotsLsCommand(rest);
  },
  "snapshots cat": async (rest) => {
    const { runSnapshotsCatCommand } = await import("./snapshots");
    await runSnapshotsCatCommand(rest);
  },
  "snapshots restore": async (rest) => {
    const { runSnapshotsRestoreCommand } = await import("./snapshots");
    await runSnapshotsRestoreCommand(rest);
  },
  "snapshots restore-sync": async (rest) => {
    const { runSnapshotsRestoreSyncCommand } = await import("./snapshots");
    await runSnapshotsRestoreSyncCommand(rest);
  },
  "snapshots legal-hold set": async (rest) => {
    const { runSnapshotsLegalHoldSetCommand } = await import("./snapshots");
    await runSnapshotsLegalHoldSetCommand(rest);
  },
  "snapshots legal-hold clear": async (rest) => {
    const { runSnapshotsLegalHoldClearCommand } = await import("./snapshots");
    await runSnapshotsLegalHoldClearCommand(rest);
  },

  "people list": async (rest) => {
    const { runPeopleListCommand } = await import("./people");
    await runPeopleListCommand(rest);
  },
  "people create": async (rest) => {
    const { runPeopleCreateCommand } = await import("./people");
    await runPeopleCreateCommand(rest);
  },
  "people update": async (rest) => {
    const { runPeopleUpdateCommand } = await import("./people");
    await runPeopleUpdateCommand(rest);
  },
  "people activate": async (rest) => {
    const { runPeopleActivateCommand } = await import("./people");
    await runPeopleActivateCommand(rest);
  },
  "people deactivate": async (rest) => {
    const { runPeopleDeactivateCommand } = await import("./people");
    await runPeopleDeactivateCommand(rest);
  },
  "offboard start": async (rest) => {
    const { runOffboardStartCommand } = await import("./people");
    await runOffboardStartCommand(rest);
  },
  "offboard sync": async (rest) => {
    const { runOffboardSyncCommand } = await import("./people");
    await runOffboardSyncCommand(rest);
  },

  "approvals list": async (rest) => {
    const { runApprovalsListCommand } = await import("./approvals");
    await runApprovalsListCommand(rest);
  },
  "approvals get": async (rest) => {
    const { runApprovalsGetCommand } = await import("./approvals");
    await runApprovalsGetCommand(rest);
  },
  "approvals decide": async (rest) => {
    const { runApprovalsDecideCommand } = await import("./approvals");
    await runApprovalsDecideCommand(rest);
  },
  "approvals create": async (rest) => {
    const { runApprovalsCreateCommand } = await import("./approvals");
    await runApprovalsCreateCommand(rest);
  },

  "org get": async (rest) => {
    const { runOrgGetCommand } = await import("./org");
    await runOrgGetCommand(rest);
  },
  "org update": async (rest) => {
    const { runOrgUpdateCommand } = await import("./org");
    await runOrgUpdateCommand(rest);
  },
  "org packages list": async (rest) => {
    const { runOrgPackagesListCommand } = await import("./org");
    await runOrgPackagesListCommand(rest);
  },
  "org packages set": async (rest) => {
    const { runOrgPackagesSetCommand } = await import("./org");
    await runOrgPackagesSetCommand(rest);
  },

  "config set": async (rest) => {
    const { runConfigSetCommand } = await import("./settings");
    await runConfigSetCommand(rest);
  },
  "config import": async (rest) => {
    const { runConfigImportCommand } = await import("./settings");
    await runConfigImportCommand(rest);
  },

  "catalog list": async (rest) => {
    const { runCatalogListCommand } = await import("./catalog");
    await runCatalogListCommand(rest);
  },
  "catalog sync": async (rest) => {
    const { runCatalogSyncCommand } = await import("./catalog");
    await runCatalogSyncCommand(rest);
  },
  capabilities: async (rest) => {
    const { runCapabilitiesCommand } = await import("./catalog");
    await runCapabilitiesCommand(rest);
  },

  "compliance checks": async (rest) => {
    const { runComplianceChecksCommand } = await import("./compliance");
    await runComplianceChecksCommand(rest);
  },
  "compliance findings": async (rest) => {
    const { runComplianceFindingsCommand } = await import("./compliance");
    await runComplianceFindingsCommand(rest);
  },
  "compliance override": async (rest) => {
    const { runComplianceOverrideCommand } = await import("./compliance");
    await runComplianceOverrideCommand(rest);
  },
  "export asset-inventory": async (rest) => {
    const { runExportAssetInventoryCommand } = await import("./compliance");
    await runExportAssetInventoryCommand(rest);
  },
  "export findings": async (rest) => {
    const { runExportFindingsCommand } = await import("./compliance");
    await runExportFindingsCommand(rest);
  },

  events: async (rest) => {
    const { runEventsCommand } = await import("./events");
    await runEventsCommand(rest);
  },

  "integrations list": async (rest) => {
    const { runIntegrationsListCommand } = await import("./integrations");
    await runIntegrationsListCommand(rest);
  },
  "integrations connect": async (rest) => {
    const { runIntegrationsConnectCommand } = await import("./integrations");
    await runIntegrationsConnectCommand(rest);
  },
  "integrations disconnect": async (rest) => {
    const { runIntegrationsDisconnectCommand } = await import("./integrations");
    await runIntegrationsDisconnectCommand(rest);
  },

  "notifications list": async (rest) => {
    const { runNotificationsListCommand } = await import("./notifications");
    await runNotificationsListCommand(rest);
  },
  "notifications read": async (rest) => {
    const { runNotificationsReadCommand } = await import("./notifications");
    await runNotificationsReadCommand(rest);
  },

  health: async (rest) => {
    const { runHealthCommand } = await import("./health");
    await runHealthCommand(rest);
  },
  version: async (rest) => {
    const { runVersionCommand } = await import("./version");
    runVersionCommand(rest);
  },
};
