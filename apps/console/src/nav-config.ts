import {
  Archive,
  Building2,
  KeyRound,
  type LucideIcon,
  Plug,
  ScrollText,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";

import { usePendingApprovalsCount } from "@/api/approvals";
import { useUnreadNotificationsCount } from "@/api/notifications";

export interface NavItem {
  label: string;
  to: string;
  group: "Operate" | "Govern" | "Configure";
  icon: LucideIcon;
  /** Static fallback badge count. Prefer registering a NavBadgeHook below for a count that updates over time. */
  badgeCount?: number;
  /**
   * Fixed icon color (a `text-*` class, both themes), independent of
   * active/hover state — every nav item gets one, so the rail reads as a row
   * of distinct identities rather than two colored icons among a run of gray
   * ones. Machines/People are exact hex, ground-truthed against the
   * reference product's own live sidebar (see their own comments below); the
   * rest draw from the dataviz skill's validated 8-slot categorical palette
   * (`references/palette.md`, slots 4/3/7/... — chosen for fit, not strict
   * slot order), which is pre-validated for CVD/contrast in both themes so
   * this list doesn't need its own re-validation as items are added.
   */
  iconColorClassName: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: "Machines",
    to: "/machines",
    group: "Operate",
    icon: Server,
    // Exact hex, not Tailwind's stock blue-500/-400: ground-truthed directly against
    // the reference product's own live sidebar (its "Companies" nav icon computes to
    // rgb(0,144,255), a distinctly more saturated, more cyan-leaning blue than
    // Tailwind's default — the mismatch a prior pass's generic blue-500 pick had).
    // Dark-mode value is this same hue lightened ~35% toward white, not ground-
    // truthed (the reference has no dark theme to check against) but following the
    // same "same hue, higher lightness" transform this app's own --primary token uses.
    iconColorClassName: "text-[#0090ff] dark:text-[#59b7ff]",
  },
  {
    label: "People",
    to: "/people",
    group: "Operate",
    icon: Users,
    // Same reasoning as Machines above — the reference product's "Contacts" nav icon
    // computes to rgb(255,122,31), close to but not identical to Tailwind's
    // orange-500; corrected to the exact measured value plus a lightened dark variant.
    iconColorClassName: "text-[#ff7a1f] dark:text-[#ffa262]",
  },
  {
    label: "Access",
    to: "/access",
    group: "Operate",
    icon: KeyRound,
    // dataviz palette slot 7 (violet) — keys/credentials read naturally as violet.
    iconColorClassName: "text-[#4a3aa7] dark:text-[#9085e9]",
  },
  {
    label: "Approvals",
    to: "/approvals",
    group: "Govern",
    icon: ShieldCheck,
    // dataviz palette slot 3 (aqua).
    iconColorClassName: "text-[#1baf7a] dark:text-[#199e70]",
  },
  {
    label: "Audit",
    to: "/audit",
    group: "Govern",
    icon: ScrollText,
    // dataviz palette slot 4 (yellow/gold) — ledger/record-keeping.
    iconColorClassName: "text-[#eda100] dark:text-[#c98500]",
  },
  {
    label: "Archive",
    to: "/archive",
    group: "Govern",
    icon: Archive,
    // dataviz palette slot 5 (magenta).
    iconColorClassName: "text-[#e87ba4] dark:text-[#d55181]",
  },
  {
    label: "Integrations",
    to: "/integrations",
    group: "Configure",
    icon: Plug,
    // dataviz palette slot 6 (green).
    iconColorClassName: "text-[#008300] dark:text-[#008300]",
  },
  {
    label: "Organisation",
    to: "/organisation",
    group: "Configure",
    icon: Building2,
    // dataviz palette slot 8 (red).
    iconColorClassName: "text-[#e34948] dark:text-[#e66767]",
  },
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
  // Unread owner notifications (spec §15: "owner notified") — Access is
  // where elevation grants against a machine you own are visible, so that's
  // where the unread count surfaces. Same badge mechanism as Approvals
  // above, not a new one — see apps/console/src/api/notifications.ts.
  // `AccessPage` itself marks every notification read on mount (there's no
  // per-notification UI yet), so visiting this page is what clears the
  // badge rather than it only ever growing.
  "/access": useUnreadNotificationsCount,
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
