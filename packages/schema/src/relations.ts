import { relations } from "drizzle-orm";
import { accessCommandRecorded } from "./tables/access-command-recorded";
import { approvalDecisions, approvals } from "./tables/approval";
import { certificates } from "./tables/certificate";
import { complianceFindingState } from "./tables/compliance-finding-state";
import { elevations } from "./tables/elevation";
import { events } from "./tables/events";
import { integrations } from "./tables/integration";
import { machines } from "./tables/machine";
import { orgs } from "./tables/org";
import { people } from "./tables/person";
import { secretBindings } from "./tables/secret-binding";
import { sessions } from "./tables/session";
import { snapshots } from "./tables/snapshot";

// Kept separate from the table files so that no table file ever needs to
// import a sibling table file just to declare a relation — every table file
// only imports the tables it has an actual column (FK-shaped or not) for.

export const orgsRelations = relations(orgs, ({ many }) => ({
  people: many(people),
  machines: many(machines),
  approvals: many(approvals),
  certificates: many(certificates),
  sessions: many(sessions),
  snapshots: many(snapshots),
  integrations: many(integrations),
  elevations: many(elevations),
  events: many(events),
  complianceFindingState: many(complianceFindingState),
  secretBindings: many(secretBindings),
}));

export const peopleRelations = relations(people, ({ one, many }) => ({
  org: one(orgs, {
    fields: [people.orgId],
    references: [orgs.id],
  }),
  ownedMachines: many(machines),
  sessions: many(sessions),
  elevations: many(elevations),
  certificates: many(certificates),
}));

export const machinesRelations = relations(machines, ({ one, many }) => ({
  org: one(orgs, {
    fields: [machines.orgId],
    references: [orgs.id],
  }),
  // Optional: cleared (not the machine deleted) during offboarding.
  owner: one(people, {
    fields: [machines.ownerPersonId],
    references: [people.id],
  }),
  sessions: many(sessions),
  snapshots: many(snapshots),
  elevations: many(elevations),
  accessCommandRecords: many(accessCommandRecorded),
  events: many(events),
}));

export const approvalsRelations = relations(approvals, ({ one, many }) => ({
  org: one(orgs, {
    fields: [approvals.orgId],
    references: [orgs.id],
  }),
  requestedBy: one(people, {
    fields: [approvals.requestedByPersonId],
    references: [people.id],
  }),
  targetMachine: one(machines, {
    fields: [approvals.targetMachineId],
    references: [machines.id],
  }),
  decisions: many(approvalDecisions),
}));

export const approvalDecisionsRelations = relations(approvalDecisions, ({ one }) => ({
  approval: one(approvals, {
    fields: [approvalDecisions.approvalId],
    references: [approvals.id],
  }),
  person: one(people, {
    fields: [approvalDecisions.personId],
    references: [people.id],
  }),
}));

export const certificatesRelations = relations(certificates, ({ one }) => ({
  org: one(orgs, {
    fields: [certificates.orgId],
    references: [orgs.id],
  }),
  person: one(people, {
    fields: [certificates.personId],
    references: [people.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  org: one(orgs, {
    fields: [sessions.orgId],
    references: [orgs.id],
  }),
  machine: one(machines, {
    fields: [sessions.machineId],
    references: [machines.id],
  }),
  person: one(people, {
    fields: [sessions.personId],
    references: [people.id],
  }),
}));

export const snapshotsRelations = relations(snapshots, ({ one }) => ({
  org: one(orgs, {
    fields: [snapshots.orgId],
    references: [orgs.id],
  }),
  machine: one(machines, {
    fields: [snapshots.machineId],
    references: [machines.id],
  }),
}));

export const integrationsRelations = relations(integrations, ({ one }) => ({
  org: one(orgs, {
    fields: [integrations.orgId],
    references: [orgs.id],
  }),
}));

export const elevationsRelations = relations(elevations, ({ one }) => ({
  org: one(orgs, {
    fields: [elevations.orgId],
    references: [orgs.id],
  }),
  person: one(people, {
    fields: [elevations.personId],
    references: [people.id],
  }),
  machine: one(machines, {
    fields: [elevations.machineId],
    references: [machines.id],
  }),
  approval: one(approvals, {
    fields: [elevations.approvalId],
    references: [approvals.id],
  }),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  org: one(orgs, {
    fields: [events.orgId],
    references: [orgs.id],
  }),
  machine: one(machines, {
    fields: [events.machineId],
    references: [machines.id],
  }),
}));

export const accessCommandRecordedRelations = relations(accessCommandRecorded, ({ one }) => ({
  machine: one(machines, {
    fields: [accessCommandRecorded.machineId],
    references: [machines.id],
  }),
}));

export const complianceFindingStateRelations = relations(complianceFindingState, ({ one }) => ({
  org: one(orgs, {
    fields: [complianceFindingState.orgId],
    references: [orgs.id],
  }),
  machine: one(machines, {
    fields: [complianceFindingState.machineId],
    references: [machines.id],
  }),
}));

export const secretBindingsRelations = relations(secretBindings, ({ one }) => ({
  org: one(orgs, {
    fields: [secretBindings.orgId],
    references: [orgs.id],
  }),
}));
