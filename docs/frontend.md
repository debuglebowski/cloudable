# Frontend

`apps/console` — Vite + React + TanStack Router (code-based routing) + TanStack Query +
shadcn/ui + Tailwind CSS. This is the console's shell: navigation, design tokens, and shared
components. Individual pages/domains are added by later feature units on top of this scaffold.

## Structure: Operate / Govern / Configure

The left nav is grouped under three fixed headers, per spec:

| Group     | Contains          |
| :-------- | :---------------- |
| Operate   | Machines, People, Access |
| Govern    | Approvals, Audit, Archive |
| Configure | Integrations, Organisation |

Nothing is hardcoded into the nav beyond the three group headers — see "Nav registration" below.

## Deliberate omissions

- **No Policies section.** Settings are inline in each object's page via `SettingRow` +
  `LineageGutter` (org → template → machine lineage shown per-field), not centralized into a
  separate policy editor.
- **No Secrets section.** Cloudable injects secrets, it never stores them (invariant 8 in
  `CLAUDE.md`) — there is nothing to list or manage in the console for this.
- **Archive is separate from Machines.** Machines are archived, never deleted (invariant 6);
  archived machines live under their own Govern nav item rather than as a filtered view of the
  Machines list, so the two lifecycles don't get conflated in one table.
- **Audit is one nav item with two in-page views**, not two nav items. It covers the
  events → checks → controls pipeline (raw event stream, and compliance/control status derived
  from it) as tabs or an in-page toggle within a single Audit page, since both views read from the
  same append-only event log.
- **No Templates.** Out of scope for this build (scope 2+, see `SCOPE.md`).

## Design tokens

Defined as CSS custom properties on `:root` in `src/index.css`, consumed as `hsl(var(--token))`
and wired into `tailwind.config.ts`'s `theme.extend.colors`:

```css
:root {
  --background: 0 0% 97.6%;
  --foreground: 220 12% 9%;
  --card: 0 0% 100%;
  --primary: 216 47% 33%;
  --primary-foreground: 0 0% 100%;
  --muted: 0 0% 96%;
  --muted-foreground: 0 0% 45%;
  --accent: 0 0% 94%;
  --accent-foreground: 220 12% 9%;
  --destructive: 0 56% 41%;
  --border: 0 0% 90%;
  --input: 0 0% 90%;
  --ring: 216 47% 33%;
  --radius: 0.75rem;

  /* Inverted (dark-on-light), not matched to --card — a tooltip needs to read as
     a distinct layer, not the same surface as the card behind it. */
  --popover: 220 12% 9%;
  --popover-foreground: 0 0% 96%;

  --ok: 164 63% 29%;      --ok-soft: 162 33% 93%;
  --drift: 34 90% 34%;    --drift-soft: 40 71% 93%;
  --stale: 216 4% 53%;    --stale-soft: 60 7% 93%;
}
```

Palette is low-chroma neutral gray/near-black (a "Zero-style" restyle pass) — `--background`
(the page floor, 97.6%) is a small, deliberately subtle step below `--card` (100%, pure white), not
a dramatic one. Ground-truthed directly against the reference product's own live app: its
`.workspace`/`.main` floor computes to `rgb(249, 249, 249)`, i.e. 97.6% — a ~6-point gap from its
own white surfaces, the same gap this token reproduces. An earlier pass dropped this to 92% on the
theory that the gap needed to be more emphatic, but that was overcorrecting a different bug (the
sidebar was still flush and shadowless at the time, so *any* floor/card contrast read as invisible)
— once the sidebar/tables became real floating cards with a shadow (and a dark-mode border), the
shadow does the separating, not raw lightness distance, and 92% read as darker than the reference
actually is. `--muted`/`--accent` (96%/94%) don't move for this — they're steps *within* a white
card (a recessed box, a hover tint), not the floor, and stay exactly as close to white as before.
`--primary` (navy) is reserved for links, the focus `--ring`, and the brand mark; it is **not** the
color of a solid button or an active nav item. `Button`'s `default` variant inverts
`bg-foreground`/`text-background` instead of using `--primary`, so the "primary action" reads as
ink-on-page and is automatically correct in dark mode with no extra token (foreground/background
already flip there). `--accent`/`--accent-foreground` are plain neutral gray, not blue-tinted, for
the same reason — an active nav item or `hover:bg-accent` target gets a quiet gray pill, not a
brand-colored one. `Button`, `Badge`, and `Tabs`' pill segments are `rounded-full`.

Every elevated surface's shadow/radius/border is now ground-truthed directly against the reference
product's own live app (devtools computed style on its real elements), not pixel-sampled off a
screenshot — a browser tab open on the actual app made this checkable partway through the restyle
pass; anything dated before that was a best-effort guess later confirmed or corrected. Two distinct
recipes came out of it, by surface size/role, not by this app's own guess at "importance":

- **In-page and anchored surfaces** — `Card` (plus any hand-rolled table wrapper that mirrors it),
  `Popover`, `Select`'s dropdown, and the sidebar (`root.tsx`'s `<aside>`) — share one identical
  shadow, `0 4px 12px 0 rgba(0,0,0,0.08)` (an arbitrary value; no Tailwind preset matches it), and
  identical `border-radius: 16px` (`rounded-2xl`, not routed through the shared `--radius` token —
  that token also drives `Input`/nav-pills, which haven't been ground-truthed). They differ only in
  border: `Card` and the sidebar both compute to `border: 0px none` — genuinely no border, confirmed
  live after an earlier pass had added one to `Card` on a mistaken pixel-sampled reading (the
  shadow's own hard edge misread as a border stroke) — while `Popover`'s real border is
  `1px solid rgb(240,240,240)` (`border-border/60` composited over `--card` reproduces this almost
  exactly, ~239 vs 240). `Popover` and `Select` both need that border for a reason specific to them,
  not decoration: every real `Select` usage opens inside a `Dialog`, the same same-`--card`-color
  adjacency `Popover` has against the sidebar — see either component's own comment for why a shadow
  alone doesn't separate them from what's behind them in dark mode.

  Dark mode is the one place `Card` (and its manual duplicates: the sidebar, the machine-detail
  Properties rail, and 5 table wrappers) departs from "no border" — a black shadow has nothing left
  to darken once it's cast onto an already-near-black surface (pixel-sampled: zero shadow
  contribution at the rendered card/floor boundary, a flat color-step). The fix is two small,
  deliberately understated mechanisms together, not one doing all the work: `--card` in `.dark` is a
  real lightness step above `--background` (16% vs. 9%, up from an initial 12% that left almost no
  gap), the "elevation via a lighter surface" pattern dark themes use in place of a shadow that can't
  read (Material, GitHub, Linear all do this) — plus a faint `border-border/35` (down from an initial
  `/60` that, alone, read as a crisp wireframe outline rather than felt elevation). Neither the
  lightened `--card` nor the border exists in the reference product, which has no dark theme to
  ground-truth against; chosen by building actual token-accurate swatches of the alternatives
  (border-only, lighten-only, blurred/glow border, top-edge-only highlight, both combined) and
  asking directly which one read right, not by guessing.

  The sidebar is also a genuine floating card, not a flush panel touching the window edges — direct,
  repeated user feedback, confirmed against the reference product's own live sidebar element:
  `margin: 6px 0 6px 6px` (inset on every side except the one touching the main content) plus the
  same `rounded-2xl`. `root.tsx`'s outer layout wrapper carries an explicit `bg-background` so the
  page's own background reads through that gap correctly instead of showing whatever the nearest
  unstyled ancestor happens to be.
- **Big centered modals** — `Dialog`/`AlertDialog`/`CommandDialog` (the ⌘K palette) — share a
  different, richer three-layer shadow (`0_1px_2px` / `0_2px_5px` / `0_2px_20px`, opacities
  0.05/0.1/0.1) and a fuller `rounded-3xl` (24px), both measured directly off the reference
  product's own real command-palette modal. No border on these either — they pop from their
  `bg-black/20` overlay dimming the page behind them first, not from the card's own edge.

`Card` (and any other `rounded-2xl` container holding a full-bleed child, e.g. a `CardContent
className="p-0"` table) also carries `overflow-hidden` — without it, a flush child's hover
background paints a sharp rectangle past the rounded corners.

Base font-size is the browser default (16px) on `html`/`body` — **do not** override it. An earlier
pass pinned it to 13.5px to make compliance tables denser, but Tailwind's spacing/sizing/type scale
is rem-based throughout, so that one override silently shrank the *entire app* to ~84% of its
intended size (sidebar, headings, icons, every padding/gap value — not just table text). Fixed by
reverting the root override and scoping density to tables instead, where it was actually wanted.
Body font is IBM Plex Sans; mono contexts (code, evidence IDs, raw values) use IBM Plex Mono; both
loaded via Google Fonts `<link>` in `index.html` with system-font fallback stacks.

Table density comes from `text-sm` on `Table` itself (`components/ui/table.tsx`) plus its cells'
own sizing — not a root-level font-size hack. Density is otherwise baked into the shadcn component
files (not left as a per-usage override): `TableHead` is `h-9 px-3.5`, `TableCell` is
`px-3.5 py-2.5`, `Button`'s default size is `h-8 px-3`. `Badge` has `ok` / `drift` / `stale`
variants (soft background + solid text/border) in addition to shadcn's defaults, mapped to the
`--ok`/`--drift`/`--stale` token pairs above.

`src/components/collapsible-section.tsx`'s `CollapsibleSection` is the detail-page counterpart to
`Card`: a chevron-toggle header (label, optional count, optional "+" add action) over borderless
content, for a sub-section of one record's page — `Card` remains the choice for a self-contained
panel (e.g. Integrations' one-topic-per-card grid), not a collapsible piece of a bigger page. Used
today by `machines/machine-detail-page.tsx`, which also introduced that page's right-hand
"Properties" rail (region/size/image/last-verified) as a plain `<aside>` — not (yet) a shared
component, since it's the only detail page; extract if a second one needs the same shape.

Two small icon-naming conventions, both under `src/components/`: `page-header-icon.tsx`'s
`PageHeaderIcon` is the small square before every page's `<h1>` (colored for the two true object
types, Machines/People, matching their sidebar nav icon; plain muted for everything else), and
`table-header-icon.tsx`'s `TableHeaderIcon` is the small muted glyph before every table column's
label naming what kind of field it is. Both reused as-is rather than duplicated inline — check
these before adding a new page or table column, most icon choices already have a precedent.

## Dark mode

`.dark` on `<html>` (matches `tailwind.config.ts`'s `darkMode: "class"`), values in `index.css`'s
`.dark` block. Not a mechanical lightness flip of the light tokens — two deliberate departures:

- `--popover` inverts the *other* way in dark mode (light-on-dark instead of dark-on-light) so a
  tooltip still reads as a distinct layer from the page, whichever theme the page is in.
- `--ok-soft` / `--drift-soft` / `--stale-soft` (and their paired text colors) are **not**
  redefined for dark — they're self-contained chip colors (pale fill + saturated text), not
  page-surface colors, so status badges stay legible and eye-catching against a dark card exactly
  like they do against a light one.

`src/components/theme-provider.tsx` owns the three-way state (`light` / `dark` / `system`),
persisted to `localStorage["cloudable-theme"]`, exposed via `useTheme()`. A small inline script in
`index.html` (kept in sync by hand, since it has to run before any app code exists to import from)
applies the class before first paint to avoid a flash of the wrong theme on load. Toggled from
inside `root.tsx`'s `AccountMenu` (a `Popover` opened by clicking the sidebar's brand row) as a
"Theme: {mode}" row that cycles light → dark → system on click without closing the menu — not a
standalone header button (there was one, `ThemeToggle`; it's gone, folded into this menu alongside
sign-out so the sidebar header keeps exactly one always-visible action, collapse). `Toaster`'s
`theme` prop reads `resolvedTheme` (always `"light"` or `"dark"`, never `"system"`) from the same
hook.

Anything that reaches for a hardcoded scrim color instead of a token should use `bg-black/NN`, not
`bg-foreground/NN` — `--foreground` flips to near-white in dark mode, which turns "dim the
backdrop" into "flash it white." `DialogOverlay` does this correctly; check new full-screen
overlays against the same trap.

## shadcn components in use

`src/components/ui/` — added via the `shadcn` CLI against this repo's `components.json`, not
hand-copied (a hand-copy is how `Button`/`Dialog` lost their `forwardRef` early on; the CLI's
templates don't have that defect). In active use: `Badge`, `Button`, `Card`, `Dialog`, `Input`,
`Textarea` (extracted once the identical hand-rolled `<textarea>` className drifted independently
in three different reason-for-X dialogs — see its own doc comment), `Table`, `Tabs`, `Tooltip`,
`Sonner` (toast), `Select`, `AlertDialog`, `Skeleton`, `Label`, `Avatar`, `Popover` (the sidebar's
`AccountMenu`), `Separator` (inside that same menu), `Command` (the ⌘K palette, see below).
Scaffolded but not yet wired into any page: `Sheet`, `ScrollArea`, `Progress` — pull them in when a
page actually needs one rather than forcing an unused component into something.

Native `<select>` was deliberately *not* kept anywhere — every picker in the app, however small, is
`Select` for visual consistency with the rest of the design system.

`src/components/command-palette.tsx` — global ⌘K/Ctrl+K palette (mounted in `root.tsx`, needs
router context so it can't live in `main.tsx`). "Go to" any `NAV_ITEMS` page; searches machines by
name (jumps to that machine's detail page) and people by email (jumps to `/people` — there's no
per-person route to land on more specifically). `NAV_ITEMS[].to` is a plain `string`, not a route
literal, so navigation goes through `useNavigate()`'s imperative `navigate({ to })` rather than the
typed `Link` — confirmed via `tsc -b` that a widened string `to` is accepted without a cast.

## Custom components

Four shared components with fixed prop contracts — do not change these signatures; extend styling
in place instead.

`src/components/lineage-gutter.tsx`:

```tsx
export type Level = "org" | "template" | "machine";
export interface LineageGutterProps {
  source: Level; // where the effective value was set
  viewing: Level; // which level is being viewed
  overriddenBelow?: number; // count of machines overriding this
}
```

`src/components/freshness.tsx`:

```tsx
export interface FreshnessProps { occurredAt: string; recordedAt: string }
```

`src/components/setting-row.tsx`:

```tsx
export interface SettingRowProps {
  label: string;
  value: unknown;
  source: "org" | "template" | "machine";
  onOverride?: (next: unknown) => void;
}
```

`src/components/control-status.tsx`:

```tsx
export interface ControlStatusProps {
  status: "pass" | "fail" | "unknown";
  label: string;
  evidenceHref?: string;
}
```

## Routing conventions (for future feature units)

Routing is code-based (`@tanstack/react-router`), registered centrally in
`src/routes/route-tree.ts` — never file-based, never scattered `createRoute` calls elsewhere
without being wired into this tree.

**Adding a page:**

1. Build your domain's route(s) under its own directory, e.g. `src/routes/machines/route.ts`,
   using `createRoute({ getParentRoute: () => rootRoute, ... })`. (`rootRoute` itself lives in
   `route-tree.ts` — import it from there.)
2. In `route-tree.ts`, import your route and append it to the `rootRoute.addChildren([...])` array.
   **Append only — never reorder or remove existing entries.** The file has a comment showing the
   exact pattern.
3. Add your own entry to `NAV_ITEMS` in `src/nav-config.ts` — one object literal per line:
   `{ label: "Machines", to: "/machines", group: "Operate" }`. `NAV_ITEMS` starts empty; each
   feature unit owns adding its own line, nobody else's.

The root layout (`src/routes/root.tsx`) renders `NAV_ITEMS` grouped under the three fixed
Operate/Govern/Configure headers and handles an empty list gracefully — so this all works
before any pages exist. Nav links are plain `<a>` tags (not TanStack's typed `Link`) because nav
entries are runtime strings from a config array, not statically-known route literals.

`src/lib/api-client.ts` exports `apiGet<T>(path)` / `apiPost<T>(path, body)` (fetch-based, base
URL from `VITE_API_URL`, throws on non-2xx) — feature units' `src/api/<domain>.ts` files build on
top of these rather than calling `fetch` directly. `src/lib/query-client.ts` exports the shared
`QueryClient` (default `staleTime: 30_000`) used by `QueryClientProvider` in `main.tsx`.
