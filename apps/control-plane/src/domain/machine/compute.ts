import type { MachineCompute } from "@cloudable/contracts";
import { machines } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../../db/layer";
import { type ComputeMetrics, ProvisioningServiceTag } from "../../services/ProvisioningService";

/** A week: long enough to see a working week's pattern, short enough to read hourly. */
export const DEFAULT_COMPUTE_HOURS = 168;

/** Turns the provider's hourly points into the numbers the machine page shows. Exported for tests. */
export function summarizeCompute(metrics: ComputeMetrics): MachineCompute["summary"] {
  const averages = metrics.points.flatMap((p) => (p.cpuAverage === null ? [] : [p.cpuAverage]));
  const maxima = metrics.points.flatMap((p) => (p.cpuMax === null ? [] : [p.cpuMax]));
  const credits = metrics.points.flatMap((p) => (p.creditsMin === null ? [] : [p.creditsMin]));
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    cpuAverage:
      averages.length > 0 ? round(averages.reduce((a, b) => a + b, 0) / averages.length) : null,
    cpuPeak: maxima.length > 0 ? round(Math.max(...maxima)) : null,
    creditsNow: metrics.burstable && credits.length > 0 ? round(credits.at(-1) ?? 0) : null,
    hoursWithoutCredits: metrics.burstable ? credits.filter((c) => c < 1).length : null,
  };
}

/**
 * How hard a machine works, and whether it is being throttled, from the cloud provider's own
 * measurements. Never fails on the provider's side: a machine whose numbers cannot be read
 * (docker, fake, or Azure refusing) says so in `unavailableReason` instead.
 */
export const machineCompute = (machineId: string, orgId: string, hours = DEFAULT_COMPUTE_HOURS) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const provisioning = yield* ProvisioningServiceTag;
    const rows = yield* Effect.tryPromise(() =>
      db.select().from(machines).where(eq(machines.id, machineId)).limit(1),
    ).pipe(Effect.orDie);
    const machine = rows[0];
    if (!machine || machine.orgId !== orgId) return null;

    const unavailable = (reason: string): MachineCompute => ({
      sizeSku: machine.sizeSku,
      available: false,
      unavailableReason: reason,
      burstable: false,
      hours,
      points: [],
      summary: { cpuAverage: null, cpuPeak: null, creditsNow: null, hoursWithoutCredits: null },
    });

    const result = yield* Effect.either(
      provisioning.metrics({
        provider: machine.provider,
        externalId: machine.externalResourceId,
        hours,
      }),
    );
    if (result._tag === "Left") {
      const cause = String(result.left.cause ?? result.left.reason);
      return unavailable(
        /\b403\b|AuthorizationFailed/.test(cause)
          ? "Cloudable may not read this machine's measurements yet. An Azure Owner must grant Microsoft.Insights/metrics/read (see the deploy notes)."
          : `The cloud provider's measurements could not be read: ${cause.slice(0, 200)}`,
      );
    }
    if (result.right === null) {
      return unavailable("This kind of machine has no measurements from its provider.");
    }
    const metrics = result.right;
    return {
      sizeSku: machine.sizeSku,
      available: true,
      burstable: metrics.burstable,
      hours,
      points: metrics.points,
      summary: summarizeCompute(metrics),
    } satisfies MachineCompute;
  });
