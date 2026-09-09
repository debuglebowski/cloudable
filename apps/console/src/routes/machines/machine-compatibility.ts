import type { CatalogItem } from "@/api/provider-catalog";

export interface CompatibilityResult {
  compatible: boolean;
  /** Only set when `compatible` is false — the other entry's required architecture. */
  reason?: string;
}

/**
 * The one real, server-enforced rule (mirrors `MachineService.ts`'s own check): two
 * catalog entries conflict only when BOTH carry a non-null architecture and those
 * values differ. Missing data on either side is never treated as a mismatch — only a
 * real, known conflict disables an option. This is the mechanism that replaces
 * per-org catalog curation (see `provider-catalog.ts`'s doc comment): real Azure
 * capability data compared live, not an admin-maintained allow-list that can
 * silently drift out of sync with what actually works. It's a near no-op today —
 * both Azure images this deployment offers require the same architecture — and
 * becomes load-bearing the moment that stops being true.
 */
export function computeCompatibility(
  a: CatalogItem | null,
  b: CatalogItem | null,
): CompatibilityResult {
  if (!a || !b || !a.architecture || !b.architecture || a.architecture === b.architecture) {
    return { compatible: true };
  }
  return { compatible: false, reason: `Needs ${b.architecture}` };
}

/** Count of `sizes` compatible with `image` — `image: null` (nothing picked yet)
 * counts everything as compatible, matching `computeCompatibility`'s own null handling. */
export function countCompatible(sizes: CatalogItem[], image: CatalogItem | null): number {
  if (!image) return sizes.length;
  return sizes.filter((size) => computeCompatibility(size, image).compatible).length;
}

// Client-side heuristic only — CatalogItem has no family field, so this is inferred
// from the SKU naming convention, not read from Azure. Disclosed via a tooltip at
// the call site, never presented as Azure-verified data. Needs manual upkeep if
// Azure introduces a new family letter.
const FAMILY_PREFIX_MAP: Record<string, string> = {
  B: "Burstable",
  D: "General purpose",
  E: "Memory optimized",
  F: "Compute optimized",
  L: "Storage optimized",
  M: "Memory optimized",
  N: "GPU / accelerated",
};

export function deriveFamily(code: string): string {
  const letter = code.match(/^Standard_([A-Za-z])/)?.[1]?.toUpperCase();
  return (letter && FAMILY_PREFIX_MAP[letter]) || "Other";
}

/** Matches on `code` as well as `displayName` — a bug fix carried over from the flat
 * form this wizard replaces, where the filter only checked `displayName` and typing
 * an exact SKU (e.g. "Standard_D4s_v5") silently failed to surface it. */
export function matchesSizeSearch(entry: CatalogItem, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.trim().toLowerCase();
  return entry.displayName.toLowerCase().includes(q) || entry.code.toLowerCase().includes(q);
}
