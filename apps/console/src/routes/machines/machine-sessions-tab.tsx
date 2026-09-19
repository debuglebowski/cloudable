import { Link } from "@tanstack/react-router";
import { Clock, Plug } from "lucide-react";
import { useState } from "react";

import { type ActiveSession, useMachineSessions } from "@/api/access";
import { PersonAvatar } from "@/components/person-avatar";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TerminateSessionDialog } from "@/routes/access/terminate-session-dialog";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Who is connected to THIS machine right now.
 *
 * A per-machine view of what the Access page lists fleet-wide, sharing its cache entry
 * rather than fetching again. Both exist on purpose: "who is on this host" is a question
 * you ask while looking at the host, and "who is connected anywhere" is one you ask under
 * time pressure and must not have to walk machines to answer.
 *
 * Terminate is offered here for the same reason the session pages moved under `/machines`:
 * the machine is where you are when you notice.
 */
export function MachineSessionsTab({ machineId }: { machineId: string }) {
  const sessionsQuery = useMachineSessions(machineId);
  const [terminateTarget, setTerminateTarget] = useState<ActiveSession | null>(null);

  return (
    <Card>
      <CardContent className="pt-4">
        {sessionsQuery.isError && (
          <p className="text-sm text-destructive">Couldn't load sessions.</p>
        )}
        {!sessionsQuery.isError && !sessionsQuery.isPending && sessionsQuery.data.length === 0 && (
          <EmptyState
            icon={Plug}
            title="No one is connected"
            description="Terminal, file and SSH sessions against this machine will appear here while they are open."
          />
        )}
        {(sessionsQuery.isPending || (sessionsQuery.data?.length ?? 0) > 0) && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>OS user</TableHead>
                <TableHead>
                  <span className="flex items-center gap-1.5">
                    <TableHeaderIcon icon={Clock} />
                    Started
                  </span>
                </TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessionsQuery.isPending &&
                Array.from({ length: 2 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton placeholder rows, never reordered.
                  <TableRow key={i}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {sessionsQuery.data?.map((session) => (
                <TableRow key={session.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <PersonAvatar name={session.personName} />
                      {session.personName}
                    </div>
                  </TableCell>
                  <TableCell className="capitalize">{session.method}</TableCell>
                  <TableCell className="font-mono text-xs">{session.osUser}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDateTime(session.startedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {/* Rejoining, not minting: the attach endpoint replays the token
                          already stored on the row, so these are plain links. An `ssh`
                          row gets neither — there is no browser leg to rejoin. */}
                      {session.method === "terminal" && (
                        <Button type="button" variant="outline" size="sm" asChild>
                          <Link
                            to="/machines/$machineId/sessions/$sessionId/terminal"
                            params={{ machineId, sessionId: session.id }}
                          >
                            Connect
                          </Link>
                        </Button>
                      )}
                      {session.method === "files" && (
                        <Button type="button" variant="outline" size="sm" asChild>
                          <Link
                            to="/machines/$machineId/sessions/$sessionId/files"
                            params={{ machineId, sessionId: session.id }}
                          >
                            Browse
                          </Link>
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setTerminateTarget(session)}
                      >
                        Terminate
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <TerminateSessionDialog
        session={terminateTarget}
        onOpenChange={(open) => {
          if (!open) setTerminateTarget(null);
        }}
      />
    </Card>
  );
}
