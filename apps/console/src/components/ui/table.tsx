import type * as React from "react";

import { cn } from "@/lib/utils";

function Table({
  className,
  containerClassName,
  ...props
}: React.HTMLAttributes<HTMLTableElement> & { containerClassName?: string }) {
  // table-scroll-shadow (index.css): every caller wraps this in a bg-card
  // container, so an overflowing table can clip columns off the edge with no
  // visual hint that scrolling reveals them — this fades a soft shadow in on
  // whichever side still has hidden content.
  //
  // max-h-[60vh]: direct user feedback — an unbounded table pushed its own
  // page (and the whole document, before the h-screen shell fix in root.tsx)
  // taller with every row, so a table that's the only thing on a page had no
  // scroll boundary of its own and no cap on how tall it could grow. This is
  // a ceiling, not a target height — a short table still just sizes to its
  // content and never shows a scrollbar; only a table with enough rows to
  // exceed 60% of the viewport starts scrolling internally, with its header
  // pinned (see TableHeader). `containerClassName` is an escape hatch for a
  // caller that wants a different cap (e.g. several tables stacked on one
  // page might want less each) — unused today, every real table takes the
  // default.
  return (
    <div
      className={cn(
        "relative max-h-[60vh] w-full overflow-auto table-scroll-shadow",
        containerClassName,
      )}
    >
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  // sticky + bg-card: Table now caps itself at max-h-[60vh] and scrolls
  // internally once a table has enough rows — without pinning the header,
  // scrolling down to a later row would scroll the column labels away with
  // it. bg-card (not transparent) so rows scrolling underneath don't show
  // through; every real caller already sits directly on a bg-card surface
  // (Card itself, or the hand-rolled table wrappers that mirror it), so this
  // never mismatches the surface behind it.
  return (
    <thead className={cn("sticky top-0 z-10 bg-card [&_tr]:border-b", className)} {...props} />
  );
}

function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableFooter({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tfoot
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      // border-border/60, not the full-strength border: a hairline, not a rule —
      // dividers should be barely-there structure, not a grid.
      className={cn(
        "border-b border-border/60 transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "h-9 px-3.5 text-left align-middle font-normal text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn("px-3.5 py-2.5 align-middle [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.HTMLAttributes<HTMLTableCaptionElement>) {
  return <caption className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
