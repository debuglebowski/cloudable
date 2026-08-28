/**
 * BYOC cost estimate (spec §14 "BYOC cost", CLAUDE.md invariant-adjacent "Not in v1:
 * billing" — "a rough sizing estimate at creation is fine — do not call it billing").
 *
 * An archived snapshot is a real Azure disk snapshot billed to the customer by Azure
 * directly for the hold period. This module produces a rough, clearly-labeled
 * order-of-magnitude projection for the Archive page — never anything presented as an
 * invoice, a bill, or a guaranteed figure.
 */

export const AZURE_SNAPSHOT_PRICING = {
  /**
   * Placeholder Azure managed-disk *incremental* snapshot price (LRS, pay-as-you-go,
   * no reserved capacity), USD per GB per month. NOT pulled from a live Azure price
   * list or the customer's own subscription — no real Azure account exists in this
   * build (see `docs/cloud-auth.md`). Good enough for a plausible order-of-magnitude
   * figure; swap for the Azure Retail Prices API when a real subscription exists.
   */
  pricePerGbMonthUsd: 0.05,
} as const;

/** Placeholder snapshot size used until this build reports real Azure disk usage —
 * no `ProvisioningService` implementation in this build surfaces snapshot size (see
 * `createSnapshot`). ~32 GiB, a plausible default machine disk size. */
export const PLACEHOLDER_SNAPSHOT_SIZE_BYTES = 32 * 1024 * 1024 * 1024;

const BYTES_PER_GB = 1_000_000_000;
const DAYS_PER_MONTH = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface CostEstimateInput {
  sizeBytes: number | null;
  expiresAt: Date;
}

/**
 * A rough, order-of-magnitude projection of what this snapshot will cost to hold
 * until it expires: `sizeBytes * pricePerGbPerDay * daysRemaining`. Returns `0` for
 * a snapshot that has already reached (or passed) its expiry — there is no remaining
 * hold period left to project. This is an ESTIMATE, never billing.
 */
export function estimateSnapshotCost(snapshot: CostEstimateInput, now: Date = new Date()): number {
  const sizeGb = (snapshot.sizeBytes ?? 0) / BYTES_PER_GB;
  const pricePerGbPerDay = AZURE_SNAPSHOT_PRICING.pricePerGbMonthUsd / DAYS_PER_MONTH;
  const daysRemaining = Math.max(0, (snapshot.expiresAt.getTime() - now.getTime()) / MS_PER_DAY);
  const estimateUsd = sizeGb * pricePerGbPerDay * daysRemaining;
  return Math.round(estimateUsd * 100) / 100;
}

export const COST_ESTIMATE_DISCLAIMER =
  "Estimate only, not billing. Azure bills this snapshot directly for the hold period; " +
  "this figure is a rough sizing projection, not an invoice.";
