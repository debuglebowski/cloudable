import { Outlet } from "@tanstack/react-router";

import { NAV_ITEMS } from "@/nav-config";

const NAV_GROUPS = ["Operate", "Govern", "Configure"] as const;

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
                    className="rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    {item.label}
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
