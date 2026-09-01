import { CircleCheck, Info, LoaderCircle, OctagonX, TriangleAlert } from "lucide-react";
import { Toaster as Sonner } from "sonner";

import { useTheme } from "@/components/theme-provider";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Upstream shadcn wires this to next-themes. This app isn't Next.js, but it does
// have its own dark mode now (see theme-provider.tsx) — `resolvedTheme` is always
// "light" or "dark" (never "system"), which is exactly what Sonner's `theme` wants.
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      // Sonner ships its own <style> tag reading `var(--normal-bg)` etc. for the
      // toast's background/text/border/radius. That tag is unlayered CSS, and
      // unlayered CSS always wins over anything in Tailwind's `@layer utilities`
      // regardless of specificity — so the `group-[.toaster]:bg-background`-style
      // classes shadcn normally wires up here were silently inert: verified live,
      // every toast rendered Sonner's own hardcoded `#fff` / `hsl(0,0%,9%)` /
      // `hsl(0,0%,93%)` defaults, not our tokens, in both themes. Feeding Sonner's
      // own CSS variables via `style` instead works *with* its cascade rather
      // than losing to it. (`--normal-description`-equivalent doesn't exist in
      // this version — `[data-description]` is a hardcoded `#3f3f3f`/dark-gray
      // with no variable hook, left as-is: close enough to --muted-foreground
      // that fighting it isn't worth an !important override.)
      //
      style={
        {
          "--normal-bg": "hsl(var(--card))",
          "--normal-text": "hsl(var(--foreground))",
          "--normal-border": "hsl(var(--border))",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      // Sonner *does* define its own `--success-bg`/`--error-bg`/etc. per toast
      // type — tried feeding those the same way as `--normal-bg` above, but its
      // own `[data-sonner-toast][data-styled=true]` rule (background/border/
      // color all via `--normal-*`) has higher specificity than `[data-type=
      // success]` (two attribute selectors vs. one), so the type-specific
      // variables are correctly *set* but never actually win the cascade — the
      // background stays `--normal-bg` regardless of type in this Sonner
      // version. Verified live before settling here: computed `background-color`
      // on a real success toast was plain white, not the pale `--ok-soft` those
      // variables resolved to. Tinting the icon directly sidesteps the whole
      // fight — these are JSX elements this file already owns outright, no
      // cascade to lose to, and a colored icon over a neutral card is the more
      // restrained pattern anyway (only the signal is colored, not the whole
      // toast). `text-*` utilities map to the same tokens Badge's `ok`/`drift`
      // variants use; `error`/`info` reuse `--destructive`/`--primary` since
      // this app has no separate soft tokens for those two.
      icons={{
        success: <CircleCheck className="h-4 w-4 text-ok" />,
        info: <Info className="h-4 w-4 text-primary" />,
        warning: <TriangleAlert className="h-4 w-4 text-drift" />,
        error: <OctagonX className="h-4 w-4 text-destructive" />,
        loading: <LoaderCircle className="h-4 w-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          // Just the group/toast marker classes now (needed so the nested
          // `group-[.toast]:` variants below still have a matching ancestor) —
          // the color/shadow utilities that used to live here never took effect.
          toast: "group toast",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
        // Sonner's own toast rule hardcodes `box-shadow: 0 4px 12px rgba(0,0,0,.1)`
        // as a literal, not a `var(--...)` the way bg/border/radius are — so
        // there's no CSS variable to feed a fix through this time. `style` here
        // renders as an inline style per toast, which beats the unlayered
        // stylesheet rule the same way an inline style always beats a
        // non-`!important` stylesheet rule. Same `shadow-lg` values as every
        // other floating surface (Dialog/AlertDialog/Popover/Select) rather than
        // a toast being the one surface with its own unrelated shadow depth.
        style: {
          boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
