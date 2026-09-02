import { Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { Cloud, LogOut, Monitor, Moon, Search, Sun } from "lucide-react";
import { useState } from "react";

import { useSessionQuery, useSignOutMutation } from "@/api/auth";
import { CommandPalette } from "@/components/command-palette";
import { type Theme, useTheme } from "@/components/theme-provider";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
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
    // Always "secondary" (a plain gray chip), never "default" (bg-foreground) —
    // a nav count badge is a quiet annotation, not a call-to-action; `active` no
    // longer changes its color, only whether it's shown at all.
    <Badge
      aria-hidden="true"
      variant="secondary"
      className="ml-auto h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1 text-[10px] leading-none"
    >
      {count}
    </Badge>
  );
}

/** A route is "current" for nav purposes on an exact match or on any of its sub-routes (e.g. a machine detail page keeps "Machines" highlighted). */
function isNavItemActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

const THEME_NEXT: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
const THEME_ICON: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const THEME_LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "System" };

/**
 * Everything that isn't a destination — signed-in identity, theme, sign-out —
 * behind one trigger (the brand row itself), not three permanent icon buttons
 * competing with the sidebar's one real always-visible action (search).
 * Matches the reference product's own account menu (a click on "Normain"
 * opens a popover with the user row, settings-ish items, and sign out at the
 * bottom) rather than Cloudable's previous approach of surfacing every one of
 * those as its own header icon.
 */
function AccountMenu({ email }: { email: string }) {
  const { theme, setTheme } = useTheme();
  const signOut = useSignOutMutation();
  const ThemeIcon = THEME_ICON[theme];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Cloud className="size-4" strokeWidth={2.25} />
          </span>
          <span className="flex-1 truncate text-base font-semibold tracking-tight">Cloudable</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-56 p-1.5">
        <p className="truncate px-2 py-1.5 text-sm text-muted-foreground" title={email}>
          {email}
        </p>
        <Separator className="my-1" />
        <button
          type="button"
          onClick={() => setTheme(THEME_NEXT[theme])}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ThemeIcon className="size-4 shrink-0" />
          Theme: {THEME_LABEL[theme]}
        </button>
        <button
          type="button"
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
        >
          <LogOut className="size-4 shrink-0" />
          Sign out
        </button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Root layout: a left nav grouped under Operate / Govern / Configure, plus the
 * matched child route. Feature units register their own pages by appending to
 * NAV_ITEMS (see src/nav-config.ts) — this layout renders whatever is there,
 * including nothing at all.
 *
 * Also the session guard for the whole console: every route is a child of
 * this one (see `route-tree.ts`), so gating here — rather than per-route —
 * covers every page in one place. `/login` itself renders with no sidebar
 * chrome, redirects to `/` if a session already exists (so it's not a
 * dead end someone can navigate back to while signed in), and every other
 * route redirects to `/login` without one.
 */
export function RootLayout() {
  const { pathname } = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const sessionQuery = useSessionQuery();

  // Deliberately renders nothing (not a spinner) while the very first
  // session check is in flight — this resolves in well under a second
  // against a local control plane, and a full-page spinner would just
  // flash for that one frame on every hard reload. Checked before the
  // `/login` branch below too, so an already-authenticated visit to
  // `/login` doesn't flash the form before redirecting to `/`.
  if (sessionQuery.isPending) {
    return null;
  }

  if (pathname === "/login") {
    return sessionQuery.data ? <Navigate to="/" /> : <Outlet />;
  }

  if (!sessionQuery.data) {
    return <Navigate to="/login" />;
  }

  return (
    // h-screen + overflow-hidden, not min-h-screen — with only a *minimum*
    // height, this row could grow taller than the viewport whenever the
    // matched route's content was tall, and the whole document (sidebar
    // included) scrolled together instead of just the content area — direct
    // user feedback that the sidebar wasn't staying put. Pinning this shell to
    // exactly the viewport and clipping it forces `main`'s own
    // `overflow-y-auto` to be the one scroll region: the sidebar (and its own
    // internal `<nav>` scroll, unrelated to this) never moves.
    <div className="flex h-screen overflow-hidden bg-background">
      {/* A floating card, not a flush panel — direct, repeated user feedback
            ("similar to the zero app"), confirmed against the reference
            product's own live sidebar element: it computes to `margin: 6px 0
            6px 6px` (inset from the top/left/bottom of the viewport, flush
            only on the side touching the content) and `border-radius: 16px`
            on all four corners, not just a flat rectangle. `my-1.5 ml-1.5`
            (6px) + `rounded-2xl` (16px, matching Card/Popover's own
            ground-truthed radius) reproduce that exactly — the shadow value
            below was already correct (ground-truthed the same way, see its
            own prior comment), it just had nothing to visually separate from
            on three sides until now. The outer wrapper needs its own
            `bg-background` explicitly: previously body's own background
            showed through everywhere the sidebar used to touch flush, but
            now there's a real gap around three of its edges that must read
            as page background, not a transparent hole.

            `dark:border` is the same dark-mode-only addition as Card's own
            (see its comment) — direct user feedback plus a live pixel-check
            confirmed a black shadow adds no visible darkening once it's cast
            onto an already-dark page; the sidebar hits the exact same
            mechanism as every other Card-shaped surface, since it shares the
            same shadow and the same lack of a light-mode border. */}
      <aside className="z-10 my-1.5 ml-1.5 flex w-60 shrink-0 flex-col rounded-2xl bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] dark:border dark:border-border/35">
        <div className="flex items-center gap-1 px-3 py-4">
          <AccountMenu email={sessionQuery.data.user.email} />
          {/* Search — icon-only (⌘K still opens it, no full pill needed for a
              shortcut this discoverable), the sidebar's only other
              always-visible action besides the account menu. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label="Search"
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Search className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Search (⌘K)</TooltipContent>
          </Tooltip>
        </div>
        <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 pb-6">
          {NAV_GROUPS.map((group) => {
            const items = NAV_ITEMS.filter((item) => item.group === group);
            return (
              <div key={group} className="flex flex-col gap-0.5">
                {/* Plain case, not uppercase/tracking-wider — a quiet group label,
                    not a shouted section rule. */}
                <span className="block rounded-md px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">
                  {group}
                </span>
                {items.map((item) => {
                  const active = isNavItemActive(pathname, item.to);
                  const Icon = item.icon;
                  return (
                    // A plain anchor (not TanStack's typed `Link`) is used deliberately:
                    // nav entries are plain strings appended by future feature units, not
                    // statically known route literals, so this sidesteps route-path typing.
                    <a
                      key={item.to}
                      href={item.to}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        active
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-foreground hover:bg-accent/60 hover:text-accent-foreground",
                      )}
                    >
                      {/* Every item carries a fixed identity color (item.iconColorClassName,
                          see nav-config.ts) that doesn't flatten to gray or shift on
                          active/hover — only the background pill signals "current". */}
                      <Icon
                        className={cn("size-4 shrink-0", item.iconColorClassName)}
                        strokeWidth={2}
                      />
                      <span>{item.label}</span>
                      <NavBadge item={item} />
                    </a>
                  );
                })}
              </div>
            );
          })}
        </nav>
      </aside>
      {/* min-h-0: a flex item's default min-height is `auto` (its content
          size), which can silently defeat `overflow-y-auto` by letting this
          grow past the row's own h-screen instead of clipping and scrolling —
          the exact bug this whole shell fix is for. */}
      <main className="min-h-0 flex-1 overflow-y-auto p-8">
        {/* Centered column, not full-bleed: every page (forms, tables, detail
            views alike) renders through this one wrapper rather than each
            picking its own width. max-w-7xl (1280px) is wide enough that the
            denser tables (audit, machines) still have room to breathe; h-full
            so height-driven pages (e.g. approvals-page.tsx's `h-full min-h-0
            flex-col`) keep filling `main`'s actual available height instead
            of losing that percentage chain through an extra wrapper level. */}
        <div className="mx-auto h-full w-full max-w-7xl">
          <Outlet />
        </div>
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
