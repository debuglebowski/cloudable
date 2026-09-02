import { Link } from "@tanstack/react-router";
import {
  Calendar,
  Clock,
  Fingerprint as FingerprintGlyph,
  Gauge,
  type LucideIcon,
  MessageSquare,
  Server,
  Tag,
  Terminal,
  User,
  UserCog,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  type ActiveSession,
  ELEVATION_LEVEL_BADGE_VARIANT,
  ELEVATION_LEVEL_LABEL,
  ELEVATION_STATUS_BADGE_VARIANT,
  type ElevationGrant,
  type LiveCertificate,
  useActiveSessions,
  useElevations,
  useExpireElevation,
  useLiveCertificates,
  useSyncElevation,
} from "@/api/access";
import { PersonAvatar } from "@/components/person-avatar";
import { TableHeaderIcon } from "@/components/table-header-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { FingerprintCell } from "./fingerprint-cell";
import { RequestElevationDialog } from "./request-elevation-dialog";
import { RevokeCertificateDialog } from "./revoke-certificate-dialog";
import { TerminateSessionDialog } from "./terminate-session-dialog";

const REASON_DISPLAY_LIMIT = 60;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function truncateReason(reason: string): string {
  if (reason.length <= REASON_DISPLAY_LIMIT) return reason;
  return `${reason.slice(0, REASON_DISPLAY_LIMIT - 1)}…`;
}

/** `TableHead` + a small muted `TableHeaderIcon` naming the field's kind (see
 * that component's own comment) — this file has three tables all wanting the
 * same icon-prefixed-header treatment, so it's a local wrapper rather than
 * repeating the icon+span markup 17 times. */
function Th({ icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <TableHead>
      <span className="flex items-center gap-1.5">
        <TableHeaderIcon icon={icon} />
        {children}
      </span>
    </TableHead>
  );
}

/** N skeleton rows, one `Skeleton` cell per width in `widths` — shown in place of `TableStatusRow`'s
 * plain "Loading…" text while a query is in flight, shaped like the row it's standing in for.
 * `lastColRight` matches that table's last `TableHead` having `text-right` (an Action column). */
function SkeletonRows({
  rows = 3,
  widths,
  lastColRight = false,
}: {
  rows?: number;
  widths: string[];
  lastColRight?: boolean;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-count skeleton placeholder rows/cells, never reordered.
        <TableRow key={i}>
          {widths.map((w, j) => {
            const isLast = lastColRight && j === widths.length - 1;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: same — fixed column order.
              <TableCell key={j} className={isLast ? "text-right" : undefined}>
                <Skeleton className={cn("h-4", w, isLast && "ml-auto")} />
              </TableCell>
            );
          })}
        </TableRow>
      ))}
    </>
  );
}

/** One-row placeholder shown instead of data rows while loading, on error, or when a query resolves empty. */
function TableStatusRow({
  colSpan,
  tone,
  children,
}: {
  colSpan: number;
  tone?: "error";
  children: ReactNode;
}) {
  return (
    <TableRow>
      <TableCell
        colSpan={colSpan}
        className={
          tone === "error" ? "text-center text-destructive" : "text-center text-muted-foreground"
        }
      >
        {children}
      </TableCell>
    </TableRow>
  );
}

type AccessTab = "certificates" | "sessions" | "elevations";

export function AccessPage() {
  const certificatesQuery = useLiveCertificates();
  const sessionsQuery = useActiveSessions();
  const elevationsQuery = useElevations();
  const syncElevation = useSyncElevation();
  const expireElevation = useExpireElevation();

  const [activeTab, setActiveTab] = useState<AccessTab>("certificates");
  const [certificateToRevoke, setCertificateToRevoke] = useState<LiveCertificate | null>(null);
  const [sessionToTerminate, setSessionToTerminate] = useState<ActiveSession | null>(null);

  return (
    // h-full min-h-0: the Tabs block below is flex-1, so it fills whatever
    // height `main` actually has left under the header instead of capping at
    // a flat vh fraction — see machines-page.tsx's comment on the same
    // pattern for a single-table page. Certificates/sessions/elevations were
    // three stacked sections before; a tab only makes sense for one row of
    // "who currently has access" at a time, not all three glued together.
    <div className="flex h-full min-h-0 flex-col gap-8">
      <div className="flex shrink-0 flex-col gap-1">
        <h1 className="text-xl font-semibold">Access</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Live certificates, active sessions, and elevation requests. Nothing else — no staleness
          clocks, no periodic access reviews, no password-authentication toggle.
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as AccessTab)}
        className="flex min-h-0 flex-1 flex-col gap-3"
      >
        <TabsList className="w-fit shrink-0">
          <TabsTrigger value="certificates">Live certificates</TabsTrigger>
          <TabsTrigger value="sessions">Active sessions</TabsTrigger>
          <TabsTrigger value="elevations">Elevation requests</TabsTrigger>
        </TabsList>

        <TabsContent value="certificates" className="mt-0 flex min-h-0 flex-1 flex-col">
          {/* Shadow on all three of this page's table wrappers, not a bare
            bg-card box — see Card's own comment for the exact value and why
            there's no border alongside it. */}
          <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] dark:border dark:border-border/35">
            <Table containerClassName="h-full max-h-none">
              <TableHeader>
                <TableRow>
                  <Th icon={User}>Person</Th>
                  <Th icon={Server}>Machine scope</Th>
                  <Th icon={FingerprintGlyph}>Fingerprint</Th>
                  <Th icon={Calendar}>Issued</Th>
                  <Th icon={Clock}>Expires</Th>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {certificatesQuery.isLoading && (
                  <SkeletonRows
                    widths={["w-24", "w-28", "w-40", "w-32", "w-32", "w-16"]}
                    lastColRight
                  />
                )}
                {certificatesQuery.isError && (
                  <TableStatusRow colSpan={6} tone="error">
                    Couldn't load certificates.
                  </TableStatusRow>
                )}
                {certificatesQuery.data?.length === 0 && (
                  <TableStatusRow colSpan={6}>No live certificates.</TableStatusRow>
                )}
                {certificatesQuery.data?.map((cert) => (
                  <TableRow key={cert.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <PersonAvatar name={cert.personName} />
                        {cert.personName}
                      </div>
                    </TableCell>
                    <TableCell>{cert.machineScopeLabel}</TableCell>
                    <TableCell>
                      <FingerprintCell fingerprint={cert.fingerprint} />
                    </TableCell>
                    <TableCell>{formatDateTime(cert.issuedAt)}</TableCell>
                    <TableCell>{formatDateTime(cert.expiresAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setCertificateToRevoke(cert)}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="sessions" className="mt-0 flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] dark:border dark:border-border/35">
            <Table containerClassName="h-full max-h-none">
              <TableHeader>
                <TableRow>
                  <Th icon={User}>Person</Th>
                  <Th icon={Server}>Machine</Th>
                  <Th icon={Terminal}>Method</Th>
                  <Th icon={UserCog}>OS user</Th>
                  <Th icon={Clock}>Started</Th>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessionsQuery.isLoading && (
                  <SkeletonRows
                    widths={["w-24", "w-24", "w-16", "w-16", "w-32", "w-20"]}
                    lastColRight
                  />
                )}
                {sessionsQuery.isError && (
                  <TableStatusRow colSpan={6} tone="error">
                    Couldn't load active sessions.
                  </TableStatusRow>
                )}
                {sessionsQuery.data?.length === 0 && (
                  <TableStatusRow colSpan={6}>No active sessions.</TableStatusRow>
                )}
                {sessionsQuery.data?.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <PersonAvatar name={session.personName} />
                        {session.personName}
                      </div>
                    </TableCell>
                    <TableCell>{session.machineName}</TableCell>
                    <TableCell className="capitalize">{session.method}</TableCell>
                    <TableCell className="font-mono text-xs">{session.osUser}</TableCell>
                    <TableCell>{formatDateTime(session.startedAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {session.method === "terminal" && (
                          // Rejoining an existing session, not a fresh mint — the attach
                          // endpoint replays the token already stored on this row (see
                          // `api/access.ts`'s `useMintSession` doc comment), so this is a
                          // plain link straight to the terminal page, no dialog needed.
                          <Button type="button" variant="outline" size="sm" asChild>
                            <Link
                              to="/access/sessions/$sessionId/terminal"
                              params={{ sessionId: session.id }}
                            >
                              Connect
                            </Link>
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setSessionToTerminate(session)}
                        >
                          Terminate
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="elevations" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 justify-end">
            <RequestElevationDialog />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-card shadow-[0_4px_12px_0_rgba(0,0,0,0.08)] dark:border dark:border-border/35">
            <Table containerClassName="h-full max-h-none">
              <TableHeader>
                <TableRow>
                  <Th icon={User}>Person</Th>
                  <Th icon={Server}>Machine</Th>
                  <Th icon={Gauge}>Level</Th>
                  <Th icon={MessageSquare}>Reason</Th>
                  <Th icon={Tag}>Status</Th>
                  <Th icon={Clock}>Expires</Th>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {elevationsQuery.isLoading && (
                  <SkeletonRows widths={["w-24", "w-24", "w-16", "w-48", "w-16", "w-32", "w-20"]} />
                )}
                {elevationsQuery.isError && (
                  <TableStatusRow colSpan={7} tone="error">
                    Couldn't load elevation requests.
                  </TableStatusRow>
                )}
                {elevationsQuery.data?.length === 0 && (
                  <TableStatusRow colSpan={7}>No elevation requests.</TableStatusRow>
                )}
                {elevationsQuery.data?.map((elevation: ElevationGrant) => (
                  <TableRow key={elevation.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <PersonAvatar name={elevation.personName} />
                        {elevation.personName}
                      </div>
                    </TableCell>
                    <TableCell>{elevation.machineName}</TableCell>
                    <TableCell>
                      <Badge variant={ELEVATION_LEVEL_BADGE_VARIANT[elevation.level]}>
                        {ELEVATION_LEVEL_LABEL[elevation.level]}
                      </Badge>
                    </TableCell>
                    <TableCell title={elevation.reason}>
                      {truncateReason(elevation.reason)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ELEVATION_STATUS_BADGE_VARIANT[elevation.status]}>
                        {elevation.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {elevation.expiresAt ? formatDateTime(elevation.expiresAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {elevation.status === "requested" && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={syncElevation.isPending}
                            onClick={() => syncElevation.mutate(elevation.id)}
                          >
                            Sync
                          </Button>
                        )}
                        {elevation.status === "granted" && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={expireElevation.isPending}
                            onClick={() => expireElevation.mutate(elevation.id)}
                          >
                            Expire
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>

      <RevokeCertificateDialog
        certificate={certificateToRevoke}
        onOpenChange={(open) => {
          if (!open) setCertificateToRevoke(null);
        }}
      />
      <TerminateSessionDialog
        session={sessionToTerminate}
        onOpenChange={(open) => {
          if (!open) setSessionToTerminate(null);
        }}
      />
    </div>
  );
}
