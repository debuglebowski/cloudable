/**
 * Cloudable's role precedence over the targets the shared contract mapped from a claim. This is
 * the part the contract deliberately leaves to each service.
 *
 * - The highest of `owner`, `admin`, `member` is the role.
 * - `approver` adds the approver flag. On its own it is not a role, so it grants no access.
 * - No role at all: denied.
 */
export type CloudableRole = "owner" | "admin" | "member";

export type CloudableDecision =
  | { readonly kind: "granted"; readonly role: CloudableRole; readonly approver: boolean }
  | { readonly kind: "denied" };

const RANK: Record<CloudableRole, number> = { member: 1, admin: 2, owner: 3 };

const isRole = (target: string): target is CloudableRole => Object.hasOwn(RANK, target);

export const decideCloudableRole = (targets: readonly string[]): CloudableDecision => {
  let role: CloudableRole | undefined;
  for (const target of targets) {
    if (isRole(target) && (role === undefined || RANK[target] > RANK[role])) role = target;
  }
  if (role === undefined) return { kind: "denied" };
  return { kind: "granted", role, approver: targets.includes("approver") };
};

/**
 * A person's stored role and flag as a grant list, the shape audit events use. `role` is free
 * text in `people`, so whatever is stored is reported as is.
 */
export const grantsOf = (person: { role: string; approver: boolean }): string[] =>
  [person.role, ...(person.approver ? ["approver"] : [])].sort();
