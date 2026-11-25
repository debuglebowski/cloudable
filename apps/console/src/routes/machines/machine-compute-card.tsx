import { useMachineCompute } from "@/api/machines";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * How hard the machine works, from the cloud provider's own measurements over the last
 * week. On a burstable size it also says whether the machine ran out of CPU credits, which
 * is what makes one feel slow: without credits Azure holds it to its base rate.
 */
export function MachineComputeCard({ machineId, sizeSku }: { machineId: string; sizeSku: string }) {
  const query = useMachineCompute(machineId, true);
  const compute = query.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Compute</CardTitle>
        <CardDescription>
          {sizeSku}, over the last {compute ? Math.round(compute.hours / 24) : 7} days, as Azure
          measured it.
          {compute?.burstable
            ? " A burstable size: it runs at full speed only while it has CPU credits."
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending && <Skeleton className="h-16 w-full" />}
        {query.isError && (
          <p className="text-sm text-destructive">Could not load the measurements.</p>
        )}
        {compute && !compute.available && (
          <p className="text-sm text-muted-foreground">{compute.unavailableReason}</p>
        )}
        {compute?.available && (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              label="Average CPU"
              value={percent(compute.summary.cpuAverage)}
              note="across the week"
            />
            <Stat label="Busiest hour" value={percent(compute.summary.cpuPeak)} note="peak use" />
            {compute.burstable && (
              <>
                <Stat
                  label="CPU credits now"
                  value={
                    compute.summary.creditsNow === null
                      ? "—"
                      : Math.round(compute.summary.creditsNow).toLocaleString()
                  }
                  note="minutes of one vCPU at full speed"
                />
                <Stat
                  label="Hours throttled"
                  value={String(compute.summary.hoursWithoutCredits ?? "—")}
                  note="hours with no credits left"
                  warn={(compute.summary.hoursWithoutCredits ?? 0) > 0}
                />
              </>
            )}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value)}%`);

function Stat({
  label,
  value,
  note,
  warn = false,
}: {
  label: string;
  value: string;
  note: string;
  warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-2xl font-semibold tabular-nums ${warn ? "text-drift" : ""}`}>{value}</dd>
      <span className="text-xs text-muted-foreground">{note}</span>
    </div>
  );
}
