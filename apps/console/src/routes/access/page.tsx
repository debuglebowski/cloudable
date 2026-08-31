import { type ReactNode, useEffect, useRef, useState } from "react";

import {
  type ActiveSession,
  ELEVATION_LEVEL_BADGE_VARIANT,
  ELEVATION_LEVEL_LABEL,
  ELEVATION_STATUS_BADGE_VARIANT,
  type ElevationGrant,
  type LiveCertificate,
  useActiveSessions,
  useElevations,
  useLiveCertificates,
} from "@/api/access";
import { useMarkNotificationsReadMutation } from "@/api/notifications";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { FingerprintCell } from "./fingerprint-cell";
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

export function AccessPage() {
  const certificatesQuery = useLiveCertificates();
  const sessionsQuery = useActiveSessions();
  const elevationsQuery = useElevations();

  const [certificateToRevoke, setCertificateToRevoke] = useState<LiveCertificate | null>(null);
  const [sessionToTerminate, setSessionToTerminate] = useState<ActiveSession | null>(null);

  // The nav badge for unread owner notifications (spec §15: "owner
  // notified") points here (see src/nav-config.ts) — there's no
  // per-notification UI yet, so simply visiting this page is what clears
  // it, mirroring "you saw the elevation activity" rather than requiring a
  // dedicated inbox. Fire-and-forget: a failure here just leaves the badge
  // as it was, no error worth surfacing on this page.
  const markNotificationsRead = useMarkNotificationsReadMutation();
  const markNotificationsReadRef = useRef(markNotificationsRead.mutate);
  markNotificationsReadRef.current = markNotificationsRead.mutate;
  useEffect(() => {
    markNotificationsReadRef.current();
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Access</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Live certificates, active sessions, and elevation requests. Nothing else — no staleness
          clocks, no periodic access reviews, no password-authentication toggle.
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Live certificates
        </h2>
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Machine scope</TableHead>
                <TableHead>Fingerprint</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {certificatesQuery.isLoading && <TableStatusRow colSpan={6}>Loading…</TableStatusRow>}
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
                  <TableCell className="font-medium">{cert.personName}</TableCell>
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
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Active sessions
        </h2>
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Machine</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>OS user</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessionsQuery.isLoading && <TableStatusRow colSpan={6}>Loading…</TableStatusRow>}
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
                  <TableCell className="font-medium">{session.personName}</TableCell>
                  <TableCell>{session.machineName}</TableCell>
                  <TableCell className="capitalize">{session.method}</TableCell>
                  <TableCell className="font-mono text-xs">{session.osUser}</TableCell>
                  <TableCell>{formatDateTime(session.startedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setSessionToTerminate(session)}
                    >
                      Terminate
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Elevation requests
        </h2>
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>Machine</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {elevationsQuery.isLoading && <TableStatusRow colSpan={6}>Loading…</TableStatusRow>}
              {elevationsQuery.isError && (
                <TableStatusRow colSpan={6} tone="error">
                  Couldn't load elevation requests.
                </TableStatusRow>
              )}
              {elevationsQuery.data?.length === 0 && (
                <TableStatusRow colSpan={6}>No elevation requests.</TableStatusRow>
              )}
              {elevationsQuery.data?.map((elevation: ElevationGrant) => (
                <TableRow key={elevation.id}>
                  <TableCell className="font-medium">{elevation.personName}</TableCell>
                  <TableCell>{elevation.machineName}</TableCell>
                  <TableCell>
                    <Badge variant={ELEVATION_LEVEL_BADGE_VARIANT[elevation.level]}>
                      {ELEVATION_LEVEL_LABEL[elevation.level]}
                    </Badge>
                  </TableCell>
                  <TableCell title={elevation.reason}>{truncateReason(elevation.reason)}</TableCell>
                  <TableCell>
                    <Badge variant={ELEVATION_STATUS_BADGE_VARIANT[elevation.status]}>
                      {elevation.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {elevation.expiresAt ? formatDateTime(elevation.expiresAt) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

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
