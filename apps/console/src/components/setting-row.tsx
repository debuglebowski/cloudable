import { Button } from "@/components/ui/button";

export interface SettingRowProps {
  label: string;
  value: unknown;
  source: "org" | "template" | "machine";
  onOverride?: (next: unknown) => void;
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
export function SettingRow({ label, value, source, onOverride }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">from {source}</span>
      </div>
      <div className="flex items-center gap-3">
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
