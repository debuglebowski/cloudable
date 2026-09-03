import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // Fully-rounded segmented control, not the shadcn-default rounded-md box —
      // the reference product's own view-switcher (lead-search.png's
      // "Companies"/"Contacts" toggle) is a pill container with a pill active
      // segment, matching this app's own pill-heavy language (Button, Badge).
      // bg-accent + a border, not bg-muted alone — muted (96%) sits only 1.6
      // points off the page floor (97.6%) and read as barely-there. accent
      // (94%) plus a hairline border gives the track a real edge to sit on.
      "inline-flex h-10 items-center justify-center rounded-full border border-border/60 bg-accent p-1 text-muted-foreground",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // Active segment inverts bg-foreground/text-background, same ink-on-page
      // treatment as Button's `default` variant, rather than a near-invisible
      // bg-background+shadow-sm lift off an equally-pale track — this is the one
      // other place in the app that needs "solid, unmistakably selected," so it
      // reuses that language instead of introducing a second one (e.g. --primary).
      "inline-flex items-center justify-center whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:text-foreground data-[state=active]:bg-foreground data-[state=active]:text-background data-[state=active]:shadow-sm data-[state=active]:hover:text-background",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
