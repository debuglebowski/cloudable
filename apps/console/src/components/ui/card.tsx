import type * as React from "react";

import { cn } from "@/lib/utils";

// Soft shadow, no border in light mode — a pixel-sampled "border" from a
// couple of loop iterations back turned out to be wrong, caught by finally
// inspecting the reference product's *live* DOM instead of a screenshot: its
// own right-rail sections (company.png's Touchpoints/Properties, now checked
// as `.sidebar-touchpoints`/`.sidebar-properties` on the real page) compute to
// `border: 0px none` — no border at all, on either one. What the earlier
// pixel scan read as a "flat, hard-edged band" (its stated reason for adding
// one) was the box-shadow itself, not a border stroke; that reasoning didn't
// hold up against ground truth. The shadow value is the real measured one —
// `rgba(0,0,0,0.08) 0 4px 12px` — identical to this app's own `Popover`, so
// the two floating-vs-resting surfaces share one shadow language.
//
// `dark:border` is new, and NOT something the reference product's own DOM can
// confirm either way (it has no dark theme) — added from direct user
// feedback plus a live pixel-check that proved the mechanism: a *black*
// shadow, however correctly it computes, has almost nothing left to darken
// once it's cast onto an already-dark `--background` — sampling the actual
// rendered boundary between two stacked cards in dark mode showed a flat,
// ungraded color-step with no additional shadow darkening at all, unlike the
// same check in light mode.
//
// A first pass made this border the *only* fix (`border-border/60`, --card
// left at 12%) — legible, but a single crisp pixel of light against near-
// black reads as a wireframe outline, not felt elevation (direct follow-up
// feedback). Now paired with a real lightness step on --card itself (12% →
// 16%, see index.css's own comment) and turned down to `/35` so the two
// mechanisms split the work instead of one doing all of it: the card is
// visibly a lighter surface on its own (the Material/GitHub/Linear "elevation
// = lighter, not just shadowed" dark-theme pattern), and the fainter border
// is a light assist rather than the entire edge. Landed on this combination
// (over lighten-only or a softened/blurred border) by building actual
// token-accurate swatches of all of them and asking directly, not by guessing.
function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // overflow-hidden: a full-bleed child (a `CardContent className="p-0"`
        // table, e.g. Audit's Timeline) otherwise touches the rounded corner
        // directly — its last row's `hover:bg-muted/50` then paints a sharp
        // rectangle that pokes past the curve. Safe for Radix
        // Select/Popover/Tooltip content, which portal to `document.body` and
        // never sit inside this clipping box in the first place.
        //
        // rounded-2xl (16px), not the shared `--radius` token (12px) — the
        // same live inspection measured this card's real `border-radius` at
        // 16px, exactly matching Popover's own (separately measured) value.
        // Not routed through `--radius` since that token also drives Dialog/
        // Input/Select/nav-pills, none of which have been checked against
        // ground truth yet — scoped to just this component until they are.
        "overflow-hidden rounded-2xl bg-card text-foreground shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] dark:border dark:border-border/35",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 p-4", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("font-semibold leading-none tracking-tight", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-0", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center p-4 pt-0", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
