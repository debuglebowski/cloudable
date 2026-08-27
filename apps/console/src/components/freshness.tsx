export interface FreshnessProps {
  occurredAt: string;
  recordedAt: string;
}

const LATE_THRESHOLD_MS = 5 * 60 * 1000;

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const diffMs = Date.now() - then;
  const diffSec = Math.round(diffMs / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 60) return "just now";

  const units: Array<[string, number]> = [
    ["y", 60 * 60 * 24 * 365],
    ["mo", 60 * 60 * 24 * 30],
    ["d", 60 * 60 * 24],
    ["h", 60 * 60],
    ["m", 60],
  ];

  for (const [label, secondsInUnit] of units) {
    if (abs >= secondsInUnit) {
      const value = Math.floor(abs / secondsInUnit);
      return diffSec >= 0 ? `${value}${label} ago` : `in ${value}${label}`;
    }
  }

  return "just now";
}

function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

/** Surfaces relative freshness of an event, and flags sleeping-machine late reporting. */
export function Freshness({ occurredAt, recordedAt }: FreshnessProps) {
  const occurredMs = new Date(occurredAt).getTime();
  const recordedMs = new Date(recordedAt).getTime();
  const gapMs = recordedMs - occurredMs;
  const isLate = Number.isFinite(gapMs) && gapMs > LATE_THRESHOLD_MS;

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>{formatRelative(occurredAt)}</span>
      {isLate && (
        <span className="text-drift" title={`recorded ${recordedAt}, occurred ${occurredAt}`}>
          reported late (+{formatGap(gapMs)})
        </span>
      )}
    </span>
  );
}
