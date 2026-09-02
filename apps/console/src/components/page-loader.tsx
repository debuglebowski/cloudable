import { Cloud } from "lucide-react";

import { cn } from "@/lib/utils";

export interface PageLoaderProps {
  label?: string;
  /** Renders as a fixed full-viewport overlay instead of filling its parent. */
  fullscreen?: boolean;
  className?: string;
}

/**
 * Centered loading state for a whole page (route transition, initial boot) —
 * not for a single card or table (those use `Skeleton`/inline "Loading…" text,
 * see `IndexPage`'s stat cards). The comet ring reuses `--foreground` so it's
 * automatically correct in dark mode with no extra token, matching the rest of
 * the design system's dark-mode-via-token-flip approach.
 */
export function PageLoader({ label = "Loading", fullscreen, className }: PageLoaderProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex w-full flex-col items-center justify-center gap-5 bg-background",
        fullscreen ? "fixed inset-0 z-50" : "min-h-[60vh]",
        className,
      )}
    >
      <div className="relative size-16">
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
          <span className="flex size-9 animate-pulse items-center justify-center rounded-lg bg-foreground text-background shadow-sm motion-reduce:animate-none [animation-duration:2s]">
            <Cloud className="size-5" strokeWidth={2.25} />
          </span>
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
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
