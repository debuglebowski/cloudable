import { acquireManagedIdentityCredential } from "./attestation/managed-identity";
import { config } from "./config";
import { ApiError, apiRequest } from "./http-client";
import type { AttestRequest, AttestResponse } from "./wire-types";

/** Fetches this method's opaque credential, per `config.attestationMethod`. */
async function acquireCredential(): Promise<string> {
  if (config.attestationMethod === "managed_identity") {
    return acquireManagedIdentityCredential();
  }
  return config.machineToken;
}

/**
 * A specific, typed failure for a credential the control plane rejected —
 * not a generic thrown error. Distinct from a transient network/HTTP
 * failure: retrying with the *same* `MACHINE_TOKEN` will not succeed, so
 * the poll/report loop logs this loudly instead of treating it like an
 * ordinary failure to back off and silently retry (see `poll-report-loop.ts`).
 */
export class AttestationRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(`attestation rejected: ${reason}`);
    this.name = "AttestationRejectedError";
  }
}

export interface CachedSession {
  readonly bearerToken: string;
  readonly expiresAt: Date;
  readonly orgId: string;
  readonly machineId: string;
}

let cached: CachedSession | undefined;

/** Refresh a little before the deadline, not exactly at it — avoids a request racing expiry. */
const EXPIRY_SKEW_MS = 60_000;

const isFresh = (session: CachedSession): boolean =>
  session.expiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS;

/** Drops the cached session, forcing the next `attest()` call to re-attest against the control plane. */
export function clearCachedSession(): void {
  cached = undefined;
}

/**
 * Exchanges `MACHINE_TOKEN` (a join token, today — see docs/agents.md) for
 * a short-lived bearer token, caching it in-process and reusing it until
 * it's close to expiry. Callers just call `attest()` every cycle; whether
 * that's a cache hit or a real round trip is this module's concern.
 */
export async function attest(): Promise<CachedSession> {
  if (cached && isFresh(cached)) return cached;

  const request: AttestRequest = {
    method: config.attestationMethod,
    credential: await acquireCredential(),
  };
  let response: AttestResponse;
  try {
    response = await apiRequest<AttestResponse>("/api/v1/agent/attest", {
      method: "POST",
      body: JSON.stringify(request),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      const body = error.body as { reason?: string } | undefined;
      throw new AttestationRejectedError(body?.reason ?? "rejected");
    }
    throw error;
  }

  cached = {
    bearerToken: response.bearerToken,
    expiresAt: new Date(response.expiresAt),
    orgId: response.orgId,
    machineId: response.machineId,
  };
  return cached;
}
