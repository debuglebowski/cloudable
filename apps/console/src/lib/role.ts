import {
  type MachineAction,
  type RoleSubject,
  canActOnMachine,
  canAdminister,
  canDecideApprovals,
} from "@cloudable/contracts";

import { useMe } from "@/api/people";

/**
 * Who the signed-in person is, for deciding what the console shows them. `undefined` while
 * `/api/v1/me` is loading. The rules themselves live in `@cloudable/contracts` (`roles.ts`), the
 * same ones the control plane enforces on every request. Hiding here is only so nobody is offered
 * a button that will be refused.
 */
export function useRoleSubject(): RoleSubject | undefined {
  const me = useMe();
  if (!me.data) return undefined;
  return { personId: me.data.id, role: me.data.role, approver: me.data.approver };
}

/** Who may see a page. */
export type PageAccess = "everyone" | "admin" | "approver";

export function canSeePage(subject: RoleSubject, access: PageAccess): boolean {
  switch (access) {
    case "everyone":
      return true;
    case "admin":
      return canAdminister(subject);
    case "approver":
      return canDecideApprovals(subject);
  }
}

/** `canActOnMachine`, false while the caller is still loading. */
export function useCanActOnMachine(
  machine: { ownerPersonId: string | null } | undefined,
  action: MachineAction,
): boolean {
  const subject = useRoleSubject();
  return (
    subject !== undefined && machine !== undefined && canActOnMachine(subject, machine, action)
  );
}

export function useIsAdmin(): boolean {
  const subject = useRoleSubject();
  return subject !== undefined && canAdminister(subject);
}
