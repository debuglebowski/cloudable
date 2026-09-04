import { Cloud } from "lucide-react";

import { cn } from "@/lib/utils";

export interface PageLoaderProps {
  label?: string;
  /** Renders as a fixed full-viewport overlay instead of filling its parent. */
  fullscreen?: boolean;
  /** `"default"` for a whole page/route body. `"sm"` for a loading state embedded in a card, tab panel, or other bounded region — same animation, scaled down so it doesn't dominate a small container. */
  size?: "default" | "sm";
  className?: string;
}

/**
 * Centered loading state — the one animation every "Loading…" placeholder in
 * the console should use, from a whole page (`size="default"`, route
 * transition, initial boot) down to a single card or tab panel (`size="sm"`).
 * The comet ring reuses `--foreground` so it's automatically correct in dark
 * mode with no extra token, matching the rest of the design system's
 * dark-mode-via-token-flip approach.
 */
export function PageLoader({
  label = "Loading",
  fullscreen,
  size = "default",
  className,
}: PageLoaderProps) {
  const sm = size === "sm";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex w-full flex-col items-center justify-center bg-background",
        sm ? "gap-2.5" : "gap-5",
        fullscreen ? "fixed inset-0 z-50" : sm ? "min-h-24" : "min-h-[60vh]",
        className,
      )}
    >
      <div className={cn("relative", sm ? "size-8" : "size-16")}>
        {/* Comet ring: a conic-gradient sweep masked down to a thin stroke, spun
            with animate-spin — reads as a trailing comet rather than a flat
            border-spinner. motion-reduce swaps it for a static ring. */}
        <div
          className="absolute inset-0 animate-spin rounded-full motion-reduce:hidden [animation-duration:1.3s]"
          style={{
            background: "conic-gradient(from 0deg, transparent 0%, hsl(var(--foreground)) 100%)",
            WebkitMask:
              "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
            mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
          }}
        />
        <div className="absolute inset-0 hidden rounded-full border-2 border-border motion-reduce:block" />
        <div className="absolute inset-[3px] rounded-full border border-border/60" />

        <div className="absolute inset-0 flex items-center justify-center">
          <span
            className={cn(
              "flex animate-pulse items-center justify-center rounded-lg bg-foreground text-background shadow-sm motion-reduce:animate-none [animation-duration:2s]",
              sm ? "size-4.5" : "size-9",
            )}
          >
            <Cloud className={sm ? "size-2.5" : "size-5"} strokeWidth={2.25} />
          </span>
        </div>
      </div>

      <p
        className={cn(
          "flex items-center gap-1.5 font-medium text-muted-foreground",
          sm ? "text-xs" : "text-sm",
        )}
      >
        {label}
        <span className="flex gap-0.5" aria-hidden="true">
          <span className="size-1 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s] [animation-duration:1s]" />
          <span className="size-1 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s] [animation-duration:1s]" />
          <span className="size-1 animate-bounce rounded-full bg-muted-foreground/60 [animation-duration:1s]" />
        </span>
      </p>
    </div>
  );
}
