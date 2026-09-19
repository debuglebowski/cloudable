import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { getMachine, machinesKeys } from "@/api/machines";

/**
 * `Machines / <name> / Terminal` above a session page.
 *
 * Both session pages are opened from a machine, but the trail used to read `Access /
 * Terminal` and link back to a page the person had very likely never been on. Naming the
 * machine is the point: a terminal is a shell on one specific host, and the page otherwise
 * says nowhere which.
 *
 * Shares `machinesKeys.detail` with the machine page itself, so arriving from "Connect"
 * reads the name straight from cache with no second fetch and no flash. The id stands in
 * while cold — never a blank, which would shift the layout as it resolved.
 */
export function SessionBreadcrumb({ machineId, leaf }: { machineId: string; leaf: string }) {
  const { data: machine } = useQuery({
    queryKey: machinesKeys.detail(machineId),
    queryFn: () => getMachine(machineId),
  });

  return (
    <div className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">
      <Link to="/machines" className="hover:text-foreground hover:underline">
        Machines
      </Link>
      <span aria-hidden="true">/</span>
      <Link
        to="/machines/$machineId"
        params={{ machineId }}
        className="hover:text-foreground hover:underline"
      >
        {machine?.name ?? machineId}
      </Link>
      <span aria-hidden="true">/</span>
      <span className="text-foreground">{leaf}</span>
    </div>
  );
}
