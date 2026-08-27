import { Badge } from "@/components/ui/badge";

export type Level = "org" | "template" | "machine";

export interface LineageGutterProps {
  /** where the effective value was set */
  source: Level;
  /** which level is being viewed */
  viewing: Level;
  /** count of machines overriding this */
  overriddenBelow?: number;
}

/**
 * Renders only the lineage label/badge for a setting — never the value itself.
 * The caller is responsible for rendering the inherited value struck-through
 * when `source !== viewing`.
 */
export function LineageGutter({ source, viewing, overriddenBelow }: LineageGutterProps) {
  const isInherited = source !== viewing;

  if (!isInherited && !overriddenBelow) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {isInherited && <span>inherited from {source}</span>}
      {overriddenBelow != null && overriddenBelow > 0 && (
        <Badge variant="secondary">
          {overriddenBelow} machine{overriddenBelow === 1 ? "" : "s"} override this
        </Badge>
      )}
    </div>
  );
}
