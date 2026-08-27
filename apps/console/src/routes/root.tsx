import { Outlet } from "@tanstack/react-router";

import { Badge } from "@/components/ui/badge";
import { NAV_BADGE_HOOKS, NAV_ITEMS, type NavItem } from "@/nav-config";

const NAV_GROUPS = ["Operate", "Govern", "Configure"] as const;

const NO_LIVE_BADGE: () => number | undefined = () => undefined;

/**
 * A nav item's badge count: a registered live hook (see NAV_BADGE_HOOKS) wins over
 * the static NavItem.badgeCount when both are present; an item with neither renders
 * no badge at all.
 *
 * `NAV_BADGE_HOOKS[item.to]` is looked up by key rather than called as a literal
 * `useXxx()` identifier, which normal rules-of-hooks lint checks can't verify. It's
 * safe today only because NAV_ITEMS is a fixed array evaluated once at module load —
 * a given `item.to` always resolves to the same hook (or none) for this component
 * instance's whole lifetime. If NAV_ITEMS is ever made conditional (e.g. filtered by
 * permissions), this lookup needs to change to something that can't vary between
 * renders of the same instance.
 */
function NavBadge({ item }: { item: NavItem }) {
  const liveHook = NAV_BADGE_HOOKS[item.to] ?? NO_LIVE_BADGE;
  const liveCount = liveHook();
  const count = liveCount ?? item.badgeCount;
  if (!count) return null;
  return (
    <Badge
      aria-hidden="true"
      variant="secondary"
      className="ml-auto h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] leading-none"
    >
      {count}
    </Badge>
  );
}

/**
 * Root layout: a left nav grouped under Operate / Govern / Configure, plus the
 * matched child route. Feature units register their own pages by appending to
 * NAV_ITEMS (see src/nav-config.ts) — this layout renders whatever is there,
 * including nothing at all.
 */
export function RootLayout() {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
        <div className="px-4 py-4 text-sm font-semibold tracking-tight">Cloudable</div>
        <nav className="flex flex-col gap-4 px-2 pb-4">
          {NAV_GROUPS.map((group) => {
            const items = NAV_ITEMS.filter((item) => item.group === group);
            return (
              <div key={group} className="flex flex-col gap-0.5">
                <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group}
                </div>
                {items.map((item) => (
                  // A plain anchor (not TanStack's typed `Link`) is used deliberately:
                  // nav entries are plain strings appended by future feature units, not
                  // statically known route literals, so this sidesteps route-path typing.
                  <a
                    key={item.to}
                    href={item.to}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    <span>{item.label}</span>
                    <NavBadge item={item} />
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
