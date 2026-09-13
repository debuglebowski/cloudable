// ---------------------------------------------------------------------------
// `cloudable sessions *` and `cloudable certs *` — the Access surface, read
// and revoked from a terminal.
//
// This is the whole surface on purpose: which certificates are live, for whom,
// expiring when, and which sessions are open. No key uploads, no per-machine
// passwords (docs/access.md).
// ---------------------------------------------------------------------------
import type { MachineScope } from "@cloudable/contracts";
import { parseArgs, readSpec, required, requiredFlag } from "./args";
import { authenticatedApiRequest, postJson, query } from "./http-client";
import { currentIdentity } from "./identity";
import { dash, printEmpty, printJson, printTable, shortTime } from "./output";

interface SessionSummary {
  id: string;
  machineId: string;
  machineName: string;
  personId: string;
  method: "terminal" | "ssh";
  osUser: string;
  startedAt: string;
}

interface CertificateSummary {
  id: string;
  personId: string;
  machineScope: MachineScope;
  fingerprint: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

function scopeLabel(scope: MachineScope): string {
  return scope === "all" ? "all" : scope.join(",");
}

export async function runSessionsListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const { orgId } = await currentIdentity();
  const res = await authenticatedApiRequest<{ sessions: SessionSummary[] }>(
    `/api/v1/access/sessions${query({ orgId })}`,
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.sessions.length === 0) {
    printEmpty("open sessions");
    return;
  }
  printTable(
    ["id", "machine", "method", "os user", "started"],
    res.sessions.map((s) => [s.id, s.machineName, s.method, s.osUser, shortTime(s.startedAt)]),
  );
}

export async function runSessionsEndCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const sessionId = required(args, 0, "a session id", "usage: cloudable sessions end <sessionId>");
  const { orgId } = await currentIdentity();
  await authenticatedApiRequest<{ ok: true }>(
    "/api/v1/access/sessions/end",
    postJson({ orgId, sessionId }),
  );
  console.log(`Ended session ${sessionId}.`);
}

export async function runCertsListCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec());
  const { orgId } = await currentIdentity();
  const res = await authenticatedApiRequest<{ certificates: CertificateSummary[] }>(
    `/api/v1/access/certificates${query({ orgId })}`,
  );
  if (args.booleans.has("json")) {
    printJson(res);
    return;
  }
  if (res.certificates.length === 0) {
    printEmpty("certificates");
    return;
  }
  printTable(
    ["id", "person", "scope", "fingerprint", "expires", "revoked"],
    res.certificates.map((c) => [
      c.id,
      c.personId,
      scopeLabel(c.machineScope),
      c.fingerprint,
      shortTime(c.expiresAt),
      c.revokedAt ? `${shortTime(c.revokedAt)} (${dash(c.revokedReason)})` : "—",
    ]),
  );
}

export async function runCertsRevokeCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = "usage: cloudable certs revoke <certificateId> --reason <reason>";
  const args = parseArgs(argv, readSpec({ values: ["reason"] }));
  const certificateId = required(args, 0, "a certificate id", usage);
  const reason = requiredFlag(args, "reason", usage);
  const { orgId } = await currentIdentity();

  await authenticatedApiRequest<{ ok: true }>(
    "/api/v1/access/certificates/revoke",
    postJson({ orgId, certificateId, reason }),
  );
  console.log(`Revoked ${certificateId}.`);
  console.log(
    "sshd is not told: the certificate's own ~8h TTL is what stops it being used (docs/access.md).",
  );
}
