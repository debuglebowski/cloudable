import { usePendingApprovalsCount } from "@/api/approvals";

export interface NavItem {
  label: string;
  to: string;
  group: "Operate" | "Govern" | "Configure";
  /** Static fallback badge count. Prefer registering a NavBadgeHook below for a count that updates over time. */
  badgeCount?: number;
}

export const NAV_ITEMS: NavItem[] = [
  // Feature units append their own entry here, one object literal per line, e.g.:
  // { label: "Machines", to: "/machines", group: "Operate" },
  { label: "Approvals", to: "/approvals", group: "Govern" },
];

/**
 * Optional live-badge hooks, keyed by NavItem.to. A feature unit whose nav badge
 * needs to poll (spec §20: Approvals is a "badged queue") registers a hook here
 * instead of relying on the static NavItem.badgeCount above. root.tsx calls
 * whichever hook is registered for a given item — it carries no per-domain query
 * knowledge itself. One entry per feature unit, same append-only convention as
 * NAV_ITEMS.
 */
export type NavBadgeHook = () => number | undefined;

export const NAV_BADGE_HOOKS: Record<string, NavBadgeHook> = {
  "/approvals": usePendingApprovalsCount,
};

if (import.meta.env.DEV) {
  for (const to of Object.keys(NAV_BADGE_HOOKS)) {
    if (!NAV_ITEMS.some((item) => item.to === to)) {
      // NAV_BADGE_HOOKS keys are free-form strings, not tied to NavItem.to at the
      // type level (nothing prevents a typo'd path in one but not the other), so
      // this catches the mismatch at dev-time instead of it silently rendering no
      // badge with no compiler error.
      console.warn(
        `NAV_BADGE_HOOKS has a hook registered for "${to}" but no NAV_ITEMS entry uses that path.`,
      );
    }
  }
}
