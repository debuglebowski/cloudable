import type { ArchivedSnapshot } from "@/api/archive";

/** Caps the retention bar so it reads as a compact table-cell indicator, not a
 * full-width bar stretching to fill the column. */
const RETENTION_BAR_MAX_WIDTH = "max-w-[96px]";

/** Fill/text pair per urgency tone — both light enough that the overlaid label stays
 * legible whether it sits over the filled or unfilled part of the bar. Mirrors the same
 * ok/drift/stale vocabulary `Badge`'s own variants use, just as a fill instead of a flat
 * chip background. */
const RETENTION_BAR_TONE = {
  ok: { fill: "bg-ok-soft", text: "text-ok" },
  drift: { fill: "bg-drift-soft", text: "text-drift" },
  stale: { fill: "bg-stale-soft", text: "text-stale" },
} as const;

/**
 * The pill itself is the progress bar: track = `bg-muted`, fill = a tinted color growing
 * from the left to `percent`, label centered on top of both. Replaces a separate flat
 * badge + a thin bar underneath — one element carries both the status label and the
 * retention-remaining visual, capped to `RETENTION_BAR_MAX_WIDTH` so it reads as a compact
 * table-cell indicator rather than stretching the column.
 */
function RetentionBar({
  label,
  percent,
  tone,
}: {
  label: string;
  percent: number;
  tone: keyof typeof RETENTION_BAR_TONE;
}) {
  const { fill, text } = RETENTION_BAR_TONE[tone];
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: a read-only status indicator, same as Radix's own Progress — never meant to receive keyboard focus.
    <div
      className={`relative h-6 w-full overflow-hidden rounded-full bg-muted ${RETENTION_BAR_MAX_WIDTH}`}
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={`absolute inset-y-0 left-0 rounded-full ${fill} transition-all`}
        style={{ width: `${percent}%` }}
      />
      <span
        className={`relative z-10 flex h-full items-center justify-center px-2 text-xs font-medium ${text}`}
      >
        {label}
      </span>
    </div>
  );
}

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
  const units = [
    { limit: 1_000_000_000_000, suffix: "TB", divisor: 1_000_000_000_000 },
    { limit: 1_000_000_000, suffix: "GB", divisor: 1_000_000_000 },
    { limit: 1_000_000, suffix: "MB", divisor: 1_000_000 },
    { limit: 1_000, suffix: "kB", divisor: 1_000 },
  ];
  for (const unit of units) {
    if (bytes >= unit.limit) return `${(bytes / unit.divisor).toFixed(1)} ${unit.suffix}`;
  }
  return `${bytes} B`;
}

/**
 * What the snapshot stores, preferring the machine's own measurement of its
 * filesystems, and falling back to the provisioned size of the disks it copied.
 *
 * The fallback is labelled "max" because it is a ceiling, not a size: it is the same
 * figure for every machine with the same disks, which is how every snapshot in the
 * fleet once displayed an identical 34 GB regardless of what was in it.
 */
export function formatSnapshotSize(snapshot: {
  sizeBytes: number;
  usedBytes: number | null;
  capturedDiskCount: number;
}): string {
  // Measured by the machine itself: the real answer, and what the provider bills.
  if (snapshot.usedBytes !== null) return formatBytes(snapshot.usedBytes);
  // Nothing was copied, so `sizeBytes` is the hardcoded 32 GiB placeholder every
  // pre-real snapshot carries -- not a disk, not a ceiling, not a measurement of
  // anything. Showing it as "34.4 GB max" just relabels the number this change set
  // out to stop showing.
  if (snapshot.capturedDiskCount === 0) return "not recorded";
  // Real disks, unmeasured contents. Provisioned size is a true upper bound.
  return `${formatBytes(snapshot.sizeBytes)} max`;
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
      <div className="flex flex-col gap-1">
        <RetentionBar label="Legal hold" percent={100} tone="stale" />
        <span className="text-xs text-muted-foreground">Exempt from expiry</span>
      </div>
    );
  }

  if (snapshot.expiredAt) {
    return (
      <div className="flex flex-col gap-1">
        <RetentionBar label="Expired" percent={0} tone="drift" />
        <span className="text-xs text-muted-foreground">on {formatDate(snapshot.expiredAt)}</span>
      </div>
    );
  }

  const remaining = daysUntil(snapshot.expiresAt);
  const urgent = remaining <= 5;
  const percentRemaining =
    snapshot.retentionDays > 0
      ? Math.min(100, Math.max(0, (remaining / snapshot.retentionDays) * 100))
      : 0;
  return (
    <div className="flex flex-col gap-1">
      <RetentionBar
        label={`${remaining} day${remaining === 1 ? "" : "s"} left`}
        percent={percentRemaining}
        tone={urgent ? "drift" : "ok"}
      />
      <span className="text-xs text-muted-foreground">
        expires {formatDate(snapshot.expiresAt)}
      </span>
    </div>
  );
}
