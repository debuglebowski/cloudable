import type { LucideIcon } from "lucide-react";

/** A small muted glyph ahead of a column header's label, naming the *kind* of
 * field it is (text/location/spec/status/time/relation) — pixel-sampled off
 * the reference product's own tables (companies.png), which prefix every
 * column header with a tiny icon this same way. A per-column choice each
 * table's own `TableHead` makes (`<TableHead><span className="flex
 * items-center gap-1.5"><TableHeaderIcon icon={...} />Label</span></TableHead>`),
 * not baked into `TableHead` itself. */
export function TableHeaderIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-3.5 shrink-0" aria-hidden="true" />;
}
