import { Button } from "@/components/ui/button";

export interface SettingRowProps {
  label: string;
  value: unknown;
  source: "org" | "template" | "machine";
  onOverride?: (next: unknown) => void;
  /**
   * The value this setting would resolve to without the override currently in effect —
   * i.e. what's inherited from the level above `source`. Pass this only when an override
   * is active; the caller renders `value` as the new effective value in that case, and
   * `inheritedValue` renders alongside it, struck through, so the override is visible
   * ("overrides render visibly with the inherited value struck through and
   * its origin named"). Omit when there's no override — `value` is already the inherited one.
   */
  inheritedValue?: unknown;
}

function formatValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A single labeled setting row with its effective value and lineage source. */
export function SettingRow({ label, value, source, onOverride, inheritedValue }: SettingRowProps) {
  return (
    // border-border/60, not the full-strength border — same hairline-not-a-rule
    // convention as TableRow's own divider (components/ui/table.tsx): this is a
    // divider between rows of one list, not a boxed grid line.
    //
    // hover:bg-muted/50, matching that same TableRow: every other place this app
    // shows a list of rows (any table) already highlights the row under the
    // cursor as a scanning aid, independent of whether the whole row is
    // clickable — Organisation's setting rows were the one row-shaped list left
    // with zero hover feedback. rounded-md since (unlike a table row) this one
    // doesn't span its container edge-to-edge, so the highlight reads as an
    // inset rectangle rather than a full-bleed strip.
    <div className="flex items-center justify-between gap-4 rounded-md border-b border-border/60 py-2.5 transition-colors last:border-b-0 hover:bg-muted/50">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">from {source}</span>
      </div>
      <div className="flex items-center gap-3">
        {inheritedValue !== undefined && (
          <span className="font-mono text-sm text-muted-foreground line-through">
            {formatValue(inheritedValue)}
          </span>
        )}
        <span className="font-mono text-sm">{formatValue(value)}</span>
        {onOverride && (
          // Unwired affordance — actual edit UX (inline input, dialog, etc.) belongs
          // to a feature unit. This just marks where it will attach.
          <Button variant="outline" size="sm" onClick={() => onOverride(value)}>
            Override
          </Button>
        )}
      </div>
    </div>
  );
}
