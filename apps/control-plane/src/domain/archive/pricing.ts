/**
 * BYOC cost estimate ("a rough sizing estimate at creation is fine — do not call it billing").
 *
 * An archived snapshot is a real Azure disk snapshot billed to the customer by Azure
 * directly for the hold period. This module produces a rough, clearly-labeled
 * order-of-magnitude projection for the Archive page — never anything presented as an
 * invoice, a bill, or a guaranteed figure.
 */

export const AZURE_SNAPSHOT_PRICING = {
  /**
   * Placeholder Azure managed-disk snapshot price (LRS, pay-as-you-go, no reserved
   * capacity), USD per GB per month. NOT pulled from a live Azure price list or the
   * subscription's own rates — swap for the Azure Retail Prices API.
   *
   * Said "incremental" until this was checked against what the adapter actually
   * creates: `snapshotOf` does not set `incremental: true`, so these are full
   * snapshots. Full ones bill on the disk's USED data rather than its provisioned
   * size, which is why a 30 GiB OS disk costs cents rather than dollars. Incremental
   * would buy nothing here anyway — each disk is copied once and then deleted, so
   * there is never a previous snapshot in the lineage to be a delta against.
   */
  pricePerGbMonthUsd: 0.05,
} as const;

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
