import type { ArchivedSnapshot } from "@/api/archive";
import { Badge } from "@/components/ui/badge";

/** Shared by the Archive page (governance, archive-trigger snapshots only) and a machine's own
 * Snapshots tab (that machine's full history) — kept here rather than duplicated in both. */

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1_000_000).toFixed(0)} MB`;
}

export function daysUntil(iso: string): number {
  // Clamped to zero: once expiresAt has passed there's a documented gap before the hard-delete
  // job sets expiredAt (see api/archive.ts), and a negative count would be misleading there.
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}

/** Retention countdown / expired / legal-hold state for one row. Never hides the "why". */
export function RetentionStatus({ snapshot }: { snapshot: ArchivedSnapshot }) {
  if (snapshot.legalHold) {
    return (
      <div className="flex flex-col gap-0.5">
        <Badge variant="secondary">Legal hold</Badge>
        <span className="text-xs text-muted-foreground">Exempt from expiry</span>
      </div>
    );
  }

  if (snapshot.expiredAt) {
    return (
      <div className="flex flex-col gap-0.5">
        <Badge variant="drift">Expired</Badge>
        <span className="text-xs text-muted-foreground">on {formatDate(snapshot.expiredAt)}</span>
      </div>
    );
  }

  const remaining = daysUntil(snapshot.expiresAt);
  const urgent = remaining <= 5;
  return (
    <div className="flex flex-col gap-0.5">
      <Badge variant={urgent ? "drift" : "ok"}>
        {remaining} day{remaining === 1 ? "" : "s"} left
      </Badge>
      <span className="text-xs text-muted-foreground">
        expires {formatDate(snapshot.expiresAt)}
      </span>
    </div>
  );
}
