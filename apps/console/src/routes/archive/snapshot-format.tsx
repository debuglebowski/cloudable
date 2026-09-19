import type { ArchivedSnapshot } from "@/api/archive";

/** Caps the retention bar so it reads as a compact table-cell indicator, not a
 * full-width bar stretching to fill the column. 112px, not 96: the longest label this
 * renders is "365 days left", measured at 93px plus 16px of padding, which left three
 * pixels of headroom and would have clipped outright on a longer retention. */
const RETENTION_BAR_MAX_WIDTH = "max-w-[112px]";

/**
 * Track/fill/text triple per urgency tone.
 *
 * The whole pill is the pale `-soft` colour and the progress is a tint of the saturated
 * one laid over it, so the label sits on a light background along its entire length.
 * That is the point: the label is centred and the fill stops at `percent`, so any word
 * long enough to cross the fill boundary sits on two different backgrounds at once.
 * This used to be `bg-muted` under a `-soft` fill, whose comment claimed both were
 * "light enough that the overlaid label stays legible" — in dark mode `--muted` is 15%
 * lightness against a 29% text colour, so "21 days left" rendered as "21 days l" with
 * the rest swallowed by the track.
 *
 * Keeping the pill light in BOTH themes is deliberate and matches `Badge`: the `-soft`
 * pairs are self-contained chip colours that index.css intentionally does not redefine
 * for dark mode, so they read as the same accent pill against a dark card as a light one.
 */
const RETENTION_BAR_TONE = {
  ok: { track: "bg-ok-soft", fill: "bg-ok/15", text: "text-ok" },
  drift: { track: "bg-drift-soft", fill: "bg-drift/15", text: "text-drift" },
  stale: { track: "bg-stale-soft", fill: "bg-stale/20", text: "text-stale" },
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
  const { track, fill, text } = RETENTION_BAR_TONE[tone];
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: a read-only status indicator, same as Radix's own Progress — never meant to receive keyboard focus.
    <div
      className={`relative h-6 w-full overflow-hidden rounded-full ${track} ${RETENTION_BAR_MAX_WIDTH}`}
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
        className={`relative z-10 flex h-full items-center justify-center whitespace-nowrap px-2 text-xs font-medium ${text}`}
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
  // Checked before legal hold, and that ordering is deliberate. A retention bar reading
  // "20 days left" over data that is already gone is the exact false reassurance the
  // integrity sweep exists to end, and a snapshot under legal hold whose data has
  // vanished is the most alarming version of it — "exempt from expiry" would be a
  // reassuring label on a hold that has already failed.
  if (snapshot.subState === "data_missing") {
    return (
      <div className="flex flex-col gap-1">
        <RetentionBar label="Data missing" percent={0} tone="stale" />
        <span className="text-xs text-muted-foreground">gone before its retention ended</span>
      </div>
    );
  }

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
