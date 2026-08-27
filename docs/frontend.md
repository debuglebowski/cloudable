# Frontend

`apps/console` — Vite + React + TanStack Router (code-based routing) + TanStack Query +
shadcn/ui + Tailwind CSS. This is the console's shell: navigation, design tokens, and shared
components. Individual pages/domains are added by later feature units on top of this scaffold.

## Structure: Operate / Govern / Configure

The left nav is grouped under three fixed headers, per spec:

| Group     | Contains          |
| :-------- | :---------------- |
| Operate   | Machines, People   |
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
  --background: 60 9% 96%;
  --foreground: 220 12% 9%;
  --card: 0 0% 100%;
  --primary: 216 47% 33%;
  --primary-foreground: 0 0% 100%;
  --muted: 50 12% 96%;
  --muted-foreground: 215 4% 44%;
  --accent: 213 44% 95%;
  --accent-foreground: 216 47% 33%;
  --destructive: 0 56% 41%;
  --border: 55 9% 88%;
  --input: 55 9% 88%;
  --ring: 216 47% 33%;
  --radius: 0.375rem;

  --ok: 164 63% 29%;      --ok-soft: 162 33% 93%;
  --drift: 34 90% 34%;    --drift-soft: 40 71% 93%;
  --stale: 216 4% 53%;    --stale-soft: 60 7% 93%;
}
```

Base font-size is 13.5px on `html`/`body` (deliberate — Tailwind's 16px default makes a 200-row
compliance table scroll unnecessarily). Body font is IBM Plex Sans; mono contexts (code, evidence
IDs, raw values) use IBM Plex Mono; both loaded via Google Fonts `<link>` in `index.html` with
system-font fallback stacks.

Density is baked into the shadcn component files themselves (not left as a per-usage override):
`TableHead` is `h-9 px-3.5`, `TableCell` is `px-3.5 py-2.5`, `Button`'s default size is `h-8 px-3`.
`Badge` has `ok` / `drift` / `stale` variants (soft background + solid text/border) in addition to
shadcn's defaults, mapped to the `--ok`/`--drift`/`--stale` token pairs above.

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
