/**
 * Roles that count as admin. `people.role` is free text, so this list is the one definition of
 * "admin" the control plane, the console and the CLI all read.
 *
 * `owner` is what the first person of an org gets (the bootstrap admin, the seeds). `admin` is
 * for anyone an owner promotes. Matching is exact: `Owner` or `administrator` is not admin, so a
 * typo can never grant it. Every other role is a member.
 *
 * The full rule set is in `docs/access.md` ("Roles"). In short:
 *
 * - A member sees and works on their own machines only. They cannot create a machine.
 * - An admin runs the org: people, settings, integrations, audit, archive, and creating a machine
 *   for a person. An admin has no live access (terminal, files, SSH) to someone else's machine.
 * - An approver is a flag on top of either role (`people.approver`). Approvers and admins decide
 *   approval requests, but nobody decides a request they made, one about themselves, or one about
 *   a machine they own. A change to approval settings needs an approver specifically.
 *
 * The control plane enforces all of it on every request. The console only hides what a person
 * cannot use.
 */
export const ADMIN_ROLES: readonly string[] = ["owner", "admin"];

export const isAdminRole = (role: string): boolean => ADMIN_ROLES.includes(role);

/** Who is asking, as far as a permission check needs to know. */
export interface RoleSubject {
  readonly personId: string;
  readonly role: string;
  readonly approver: boolean;
}

/** Admin pages: People, Access (everyone's), Audit, Archive, Integrations, Organisation. */
export const canAdminister = (subject: RoleSubject): boolean => isAdminRole(subject.role);

/** The Approvals page, and deciding requests on it. */
export const canDecideApprovals = (subject: RoleSubject): boolean =>
  subject.approver || isAdminRole(subject.role);

/** Seeing a machine at all: its owner, or an admin. */
export const canSeeMachine = (
  subject: RoleSubject,
  machine: { ownerPersonId: string | null },
): boolean => isAdminRole(subject.role) || machine.ownerPersonId === subject.personId;

/**
 * What can be done to a machine once it can be seen.
 *
 * - `connect`: terminal, files, SSH. The owner only. Never an admin on someone else's machine, and
 *   never anyone on a machine with no owner.
 * - `archive`: the owner only. An admin archives someone else's machine by offboarding them.
 * - `restart`, `upgrade`, `snapshot`, `packages`: the owner or an admin. Every one is recorded.
 * - `editManifest`: what packages a machine may have is configuration, so admin only.
 */
export type MachineAction =
  | "connect"
  | "archive"
  | "restart"
  | "upgrade"
  | "snapshot"
  | "packages"
  | "editManifest";

export const canActOnMachine = (
  subject: RoleSubject,
  machine: { ownerPersonId: string | null },
  action: MachineAction,
): boolean => {
  const isOwner = machine.ownerPersonId !== null && machine.ownerPersonId === subject.personId;
  const isAdmin = isAdminRole(subject.role);
  switch (action) {
    case "connect":
    case "archive":
      return isOwner;
    case "restart":
    case "upgrade":
    case "snapshot":
    case "packages":
      return isOwner || isAdmin;
    case "editManifest":
      return isAdmin;
  }
};
