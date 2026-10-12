/**
 * Roles that count as admin. `people.role` is free text, so this list is the one definition of
 * "admin" the control plane, the console and the CLI all read.
 *
 * `owner` is what the first person of an org gets (the bootstrap admin, the seeds). `admin` is
 * for anyone an owner promotes. Matching is exact: `Owner` or `administrator` is not admin, so a
 * typo can never grant it.
 *
 * What admin allows today: changing vulnerability scanning settings, and changing anyone's role
 * or granting an admin role. Nothing else checks a role yet.
 */
export const ADMIN_ROLES: readonly string[] = ["owner", "admin"];

export const isAdminRole = (role: string): boolean => ADMIN_ROLES.includes(role);
