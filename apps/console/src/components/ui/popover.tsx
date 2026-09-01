"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";

import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      // `bg-card text-foreground`. `rounded-2xl` (16px) — measured directly off
      // the reference product's own live app (its workspace-switcher popover's
      // real computed `border-radius: 16px`), not estimated from a screenshot:
      // noticeably more rounded than Card/Dialog's 12px, a small floating menu
      // reading softer than a full page-sized panel.
      //
      // Shadow + border both corrected the same way, from the same live
      // inspection (devtools on the actual popover element, not a pixel guess):
      // the real value is a small, restrained `0 4px 12px 0 rgba(0,0,0,0.08)`
      // plus a genuine `1px solid rgb(240,240,240)` border — i.e. the border
      // does most of the separation work and the shadow is a soft touch on top,
      // the opposite of what a heavier shadow-only treatment (this app's
      // previous `shadow-lg`, then an overcorrected `shadow-2xl`) assumed.
      // `border-border/60` composited over `--card` already lands at ~239,
      // effectively the same gray — confirms that hairline-opacity choice
      // rather than changing it. The border is why this one stays legible even
      // in dark mode, where this popover and the sidebar it opens from share
      // the *same* `--card` color: a black shadow of any strength barely
      // registers against an already-dark surrounding (shadows read as
      // darkening, which a dark background has little contrast left to give),
      // but a border's own explicit color doesn't have that problem. Dialog/
      // AlertDialog don't need one — their `bg-black/20` overlay dims the page
      // behind them first, so they pop from contrast, not shadow or border.
      className={cn(
        "z-50 w-72 rounded-2xl border border-border/60 bg-card p-4 text-foreground shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-popover-content-transform-origin]",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent };
