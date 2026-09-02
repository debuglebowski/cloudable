import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { BadgeProps } from "@/components/ui/badge";
import { apiGet, apiPost } from "@/lib/api-client";
import { CURRENT_ORG_ID } from "@/lib/current-org";
import { listMachines } from "./machines";
import { listPeople } from "./people-directory";

// ---------------------------------------------------------------------------
// Access domain: live SSH certificates, active sessions, elevation requests.
// Wired to the real `apps/control-plane/src/http/routes/{access,elevations}
// .ts` (units 12/17), including two list endpoints
// (`listSessions`/`elevations.list`) added specifically for this page — the
// real backend originally had no way to list either beyond a single item by
// id. `personName`/`machineScopeLabel` are resolved client-side against the
// real `/api/v1/people` and machines lists; sessions/elevations already come
// back with `machineName` pre-joined server-side.
//
// Certificate/session-listing/end calls here still send `orgId: CURRENT_ORG_ID`
// explicitly (see `routes/access.ts`'s own header comment for exactly which
// endpoints and why — mostly "not actually wrong yet, hasn't needed
// migrating"). `mintSession` below is the one exception that DOES need a real
// identity — see its own comment. `elevations.ts` below is fully
// session-authenticated — those calls correctly send neither.
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
    // Shell can read injected secrets on a live machine — call that out
    // visually the same way a failed control does, via the `drift`
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

interface CertificateSummaryWire {
  id: string;
  personId: string;
  machineScope: "all" | string[];
  fingerprint: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

interface SessionSummaryWire {
  id: string;
  machineId: string;
  machineName: string;
  personId: string;
  method: "terminal" | "ssh";
  osUser: string;
  startedAt: string;
}

interface ElevationListItemWire {
  id: string;
  personId: string;
  machineId: string;
  machineName: string;
  level: "file_recovery" | "shell";
  reason: string;
  status: "requested" | "granted" | "expired" | "denied";
  expiresAt: string | null;
}

async function fetchLiveCertificates(): Promise<LiveCertificate[]> {
  const [res, people, machines] = await Promise.all([
    apiGet<{ certificates: CertificateSummaryWire[] }>(
      `/api/v1/access/certificates?orgId=${CURRENT_ORG_ID}`,
    ),
    listPeople(),
    listMachines(),
  ]);
  const machineName = (id: string) => machines.find((m) => m.id === id)?.name ?? id;
  return res.certificates
    .filter((c) => c.revokedAt == null && new Date(c.expiresAt).getTime() > Date.now())
    .map((c) => ({
      id: c.id,
      personName: people.find((p) => p.id === c.personId)?.email ?? c.personId,
      machineScopeLabel:
        c.machineScope === "all" ? "All machines" : c.machineScope.map(machineName).join(", "),
      fingerprint: c.fingerprint,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
    }));
}

async function revokeCertificateRequest(id: string, reason: string): Promise<void> {
  await apiPost("/api/v1/access/certificates/revoke", {
    orgId: CURRENT_ORG_ID,
    certificateId: id,
    reason,
  });
}

async function fetchActiveSessions(): Promise<ActiveSession[]> {
  const [res, people] = await Promise.all([
    apiGet<{ sessions: SessionSummaryWire[] }>(`/api/v1/access/sessions?orgId=${CURRENT_ORG_ID}`),
    listPeople(),
  ]);
  return res.sessions.map((s) => ({
    id: s.id,
    personName: people.find((p) => p.id === s.personId)?.email ?? s.personId,
    machineName: s.machineName,
    method: s.method,
    osUser: s.osUser,
    startedAt: s.startedAt,
  }));
}

async function terminateSessionRequest(id: string): Promise<void> {
  await apiPost("/api/v1/access/sessions/end", { orgId: CURRENT_ORG_ID, sessionId: id });
}

async function fetchElevations(): Promise<ElevationGrant[]> {
  const [res, people] = await Promise.all([
    apiGet<{ elevations: ElevationListItemWire[] }>("/api/v1/elevations"),
    listPeople(),
  ]);
  return res.elevations.map((e) => ({
    id: e.id,
    personName: people.find((p) => p.id === e.personId)?.email ?? e.personId,
    machineName: e.machineName,
    level: e.level,
    reason: e.reason,
    status: e.status,
    expiresAt: e.expiresAt,
  }));
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
      toast.success("Certificate revoked");
    },
    onError: (error) => {
      toast.error("Couldn't revoke certificate", { description: error.message });
    },
  });
}

export function useTerminateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => terminateSessionRequest(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessKeys.sessions() });
      toast.success("Session terminated");
    },
    onError: (error) => {
      toast.error("Couldn't terminate session", { description: error.message });
    },
  });
}

export interface MintSessionInput {
  targetMachineId: string;
  targetOsUser: string;
}

export interface MintedSession {
  sessionId: string;
  token: string;
  expiresAt: string;
}

/** Real `POST /api/v1/access/sessions`, method fixed to `"terminal"` — this is the web
 * terminal's mint call specifically; the `"ssh"` method's session-accounting
 * mint has no console-side caller of its own, real SSH access goes through `cloudable
 * login`'s certificate flow instead, not this dialog. `orgId`/`personId`/`idpIdentity`
 * are derived server-side from the caller's own session, never sent here — a wrong or
 * client-supplied identity on this specific call is a real access-control bug, not just a
 * missing convenience (see `http/routes/access.ts`'s header comment on `mintSession`). */
async function mintSessionRequest(input: MintSessionInput): Promise<MintedSession> {
  return apiPost<MintedSession>("/api/v1/access/sessions", {
    targetMachineId: input.targetMachineId,
    targetOsUser: input.targetOsUser,
    method: "terminal",
  });
}

export function useMintSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: mintSessionRequest,
    onSuccess: () => {
      // The new session is now genuinely live — worth refreshing the Access page's own
      // list even though this hook's caller navigates away immediately afterward (coming
      // back to Access should already show it as an active session).
      void queryClient.invalidateQueries({ queryKey: accessKeys.sessions() });
    },
    onError: (error) => {
      toast.error("Couldn't connect", { description: error.message });
    },
  });
}

export interface RequestElevationInput {
  machineId: string;
  level: ElevationGrant["level"];
  reason: string;
}

/** `personId` is derived server-side from the caller's own session — the requester is always
 * whoever is signed in, never a client-supplied id (see `http/middleware/auth.ts`). */
async function requestElevationRequest(input: RequestElevationInput): Promise<void> {
  await apiPost("/api/v1/elevations", {
    machineId: input.machineId,
    level: input.level,
    reason: input.reason,
  });
}

async function syncElevationRequest(id: string): Promise<void> {
  await apiPost(`/api/v1/elevations/${id}/sync`);
}

async function expireElevationRequest(id: string): Promise<void> {
  await apiPost(`/api/v1/elevations/${id}/expire`);
}

export function useRequestElevation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: requestElevationRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessKeys.elevations() });
      toast.success("Elevation requested");
    },
    onError: (error) => {
      toast.error("Couldn't request elevation", { description: error.message });
    },
  });
}

export function useSyncElevation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: syncElevationRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessKeys.elevations() });
    },
    onError: (error) => {
      toast.error("Couldn't sync elevation", { description: error.message });
    },
  });
}

export function useExpireElevation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: expireElevationRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessKeys.elevations() });
      toast.success("Elevation expired");
    },
    onError: (error) => {
      toast.error("Couldn't expire elevation", { description: error.message });
    },
  });
}
