import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { BadgeProps } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Access domain: live SSH certificates, active sessions, elevation requests.
//
// Units 12 (SSH/tunnel) and 17 (elevation) own the control-plane routes this
// page would read from (`packages/schema/src/tables/{certificate,session,
// elevation}.ts`). Their PRs are open but not merged into the bootstrap-only
// `main` this unit forked from, so there is no `/access/*` HTTP surface to
// call yet. Everything below is realistic in-memory mock data (with
// simulated network latency) behind the same query-hook shape a real
// implementation would use — no `apiGet`/`apiPost` calls from
// `@/lib/api-client` yet, since there's nothing to call. Wiring this up to
// the real endpoints later means swapping the bodies of the
// `fetch*`/`*Request` functions below for `apiGet`/`apiPost` calls; the
// hooks, the query keys, and the page do not need to change.
// ---------------------------------------------------------------------------

export interface LiveCertificate {
  id: string;
  personName: string;
  machineScopeLabel: string;
  fingerprint: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ActiveSession {
  id: string;
  personName: string;
  machineName: string;
  method: "terminal" | "ssh";
  osUser: string;
  startedAt: string;
}

export interface ElevationGrant {
  id: string;
  personName: string;
  machineName: string;
  level: "file_recovery" | "shell";
  reason: string;
  status: "requested" | "granted" | "expired" | "denied";
  expiresAt: string | null;
}

export const ELEVATION_LEVEL_LABEL: Record<ElevationGrant["level"], string> = {
  file_recovery: "File recovery",
  shell: "Shell",
};

export const ELEVATION_LEVEL_BADGE_VARIANT: Record<ElevationGrant["level"], BadgeProps["variant"]> =
  {
    // Shell can read injected secrets on a live machine (docs/spec.md §15) — call
    // that out visually the same way a failed control does, via the `drift`
    // badge variant, rather than inventing a new one.
    file_recovery: "secondary",
    shell: "drift",
  };

export const ELEVATION_STATUS_BADGE_VARIANT: Record<
  ElevationGrant["status"],
  BadgeProps["variant"]
> = {
  requested: "outline",
  granted: "ok",
  expired: "stale",
  denied: "destructive",
};

const now = Date.now();
const hoursFromNow = (n: number): string => new Date(now + n * 60 * 60 * 1000).toISOString();

interface CertificateRecord extends LiveCertificate {
  revokedAt: string | null;
  revokedReason: string | null;
}

interface SessionRecord extends ActiveSession {
  endedAt: string | null;
}

function delay<T>(value: T, ms = 300): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const mockCertificates: CertificateRecord[] = [
  {
    id: "cert-1",
    personName: "Amara Chen",
    machineScopeLabel: "All machines",
    fingerprint: "SHA256:1f9c7a3e5d2b8064af11cd77e2f0938a6b4d5c1e9f0a3b7c2d8e4f6019a2b3c4",
    issuedAt: hoursFromNow(-3),
    expiresAt: hoursFromNow(5),
    revokedAt: null,
    revokedReason: null,
  },
  {
    id: "cert-2",
    personName: "Diego Ramirez",
    machineScopeLabel: "web-01, web-02",
    fingerprint: "SHA256:8e2d4f6a0c1b3d5e7f9a2c4e6081a3b5d7f9012c4e6a8b0d2f4610a3c5e7f901",
    issuedAt: hoursFromNow(-1),
    expiresAt: hoursFromNow(7),
    revokedAt: null,
    revokedReason: null,
  },
  {
    id: "cert-3",
    personName: "Priya Natarajan",
    machineScopeLabel: "All machines",
    fingerprint: "SHA256:4b6d8f0a2c4e6801a3c5e7f90b2d4f6180a2c4e6f8091b3d5f7a9c1e3f5a7b90",
    issuedAt: hoursFromNow(-6),
    expiresAt: hoursFromNow(2),
    revokedAt: null,
    revokedReason: null,
  },
  {
    id: "cert-4",
    personName: "Owen Fitzgerald",
    machineScopeLabel: "db-primary",
    fingerprint: "SHA256:7a9c1e3f5b7d9f01c3e5a7092c4e6f81a3c5e7091b3d5f7a9c1e3f5a7c9e1f30",
    issuedAt: hoursFromNow(-0.5),
    expiresAt: hoursFromNow(7.5),
    revokedAt: null,
    revokedReason: null,
  },
];

const mockSessions: SessionRecord[] = [
  {
    id: "session-1",
    personName: "Amara Chen",
    machineName: "web-01",
    method: "terminal",
    osUser: "amara",
    startedAt: hoursFromNow(-0.4),
    endedAt: null,
  },
  {
    id: "session-2",
    personName: "Diego Ramirez",
    machineName: "db-primary",
    method: "ssh",
    osUser: "diego",
    startedAt: hoursFromNow(-0.07),
    endedAt: null,
  },
  {
    id: "session-3",
    personName: "Priya Natarajan",
    machineName: "web-02",
    method: "terminal",
    osUser: "priya",
    startedAt: hoursFromNow(-1.2),
    endedAt: null,
  },
];

const mockElevations: ElevationGrant[] = [
  {
    id: "elevation-1",
    personName: "Owen Fitzgerald",
    machineName: "db-primary",
    level: "shell",
    reason: "Investigate slow query locking checkout table",
    status: "granted",
    expiresAt: hoursFromNow(0.7),
  },
  {
    id: "elevation-2",
    personName: "Diego Ramirez",
    machineName: "web-01",
    level: "file_recovery",
    reason: "Restore nginx config from last night's snapshot",
    status: "requested",
    expiresAt: null,
  },
  {
    id: "elevation-3",
    personName: "Priya Natarajan",
    machineName: "web-02",
    level: "shell",
    reason: "Attach a profiler to debug a suspected memory leak",
    status: "requested",
    expiresAt: null,
  },
  {
    id: "elevation-4",
    personName: "Amara Chen",
    machineName: "db-primary",
    level: "file_recovery",
    reason: "Recover accidentally deleted audit logs",
    status: "expired",
    expiresAt: hoursFromNow(-0.2),
  },
  {
    id: "elevation-5",
    personName: "Diego Ramirez",
    machineName: "db-primary",
    level: "shell",
    reason: "Read production secrets to reproduce a payments bug locally",
    status: "denied",
    expiresAt: null,
  },
];

function isCertificateLive(cert: CertificateRecord): boolean {
  return cert.revokedAt == null && new Date(cert.expiresAt).getTime() > Date.now();
}

async function fetchLiveCertificates(): Promise<LiveCertificate[]> {
  const live = mockCertificates
    .filter(isCertificateLive)
    .map(({ id, personName, machineScopeLabel, fingerprint, issuedAt, expiresAt }) => ({
      id,
      personName,
      machineScopeLabel,
      fingerprint,
      issuedAt,
      expiresAt,
    }));
  return delay(live);
}

async function revokeCertificateRequest(id: string, reason: string): Promise<void> {
  const cert = mockCertificates.find((candidate) => candidate.id === id);
  if (cert) {
    cert.revokedAt = new Date().toISOString();
    cert.revokedReason = reason;
  }
  await delay(undefined, 300);
}

async function fetchActiveSessions(): Promise<ActiveSession[]> {
  const active = mockSessions
    .filter((session) => session.endedAt == null)
    .map(({ id, personName, machineName, method, osUser, startedAt }) => ({
      id,
      personName,
      machineName,
      method,
      osUser,
      startedAt,
    }));
  return delay(active);
}

async function terminateSessionRequest(id: string): Promise<void> {
  const session = mockSessions.find((candidate) => candidate.id === id);
  if (session) {
    session.endedAt = new Date().toISOString();
  }
  await delay(undefined, 300);
}

async function fetchElevations(): Promise<ElevationGrant[]> {
  return delay([...mockElevations]);
}

export const accessKeys = {
  certificates: () => ["access", "certificates"] as const,
  sessions: () => ["access", "sessions"] as const,
  elevations: () => ["access", "elevations"] as const,
};

export function useLiveCertificates() {
  return useQuery({
    queryKey: accessKeys.certificates(),
    queryFn: fetchLiveCertificates,
  });
}

export function useActiveSessions() {
  return useQuery({
    queryKey: accessKeys.sessions(),
    queryFn: fetchActiveSessions,
  });
}

export function useElevations() {
  return useQuery({
    queryKey: accessKeys.elevations(),
    queryFn: fetchElevations,
  });
}

export function useRevokeCertificate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      revokeCertificateRequest(id, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessKeys.certificates() });
    },
  });
}

export function useTerminateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => terminateSessionRequest(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessKeys.sessions() });
    },
  });
}
