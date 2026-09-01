// Azure Instance Metadata Service (IMDS) — docs/spec.md §9: "Azure managed
// identity — token from IMDS, verified against the published key set."
//
// IMDS (`169.254.169.254`) is a link-local address only reachable from
// inside an Azure VM, so it cannot be hit from this sandbox/CI. The base URL
// is configurable via `IMDS_ENDPOINT` (defaulting to the real Azure
// address) precisely so this can be pointed at a local mock HTTP server for
// testing — see `managed-identity.test.ts`.

const DEFAULT_IMDS_ENDPOINT = "http://169.254.169.254/metadata/identity/oauth2/token";
const IMDS_API_VERSION = "2018-02-01";
const DEFAULT_RESOURCE = "https://management.azure.com/";

/** Thrown when IMDS responds with a non-2xx status or an unusable body. */
export class ImdsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ImdsError";
  }
}

export interface AcquireManagedIdentityCredentialOptions {
  /** The resource the token should be scoped to. Defaults to Azure Resource Manager. */
  resource?: string;
  /** Identify a specific user-assigned identity; omit for the VM's system-assigned identity. */
  identityQuery?: Partial<Record<"object_id" | "client_id" | "msi_res_id", string>>;
}

/**
 * Fetches an OAuth2 access token from IMDS for the VM's managed identity.
 * Returns the raw access token string — the opaque credential the
 * control-plane-side `AttestationMethod` port's `verifyCredential` expects
 * (docs/spec.md §9: "both taking opaque strings").
 */
export async function acquireManagedIdentityCredential(
  options: AcquireManagedIdentityCredentialOptions = {},
): Promise<string> {
  const base = process.env.IMDS_ENDPOINT ?? DEFAULT_IMDS_ENDPOINT;
  const url = new URL(base);
  url.searchParams.set("api-version", IMDS_API_VERSION);
  url.searchParams.set("resource", options.resource ?? DEFAULT_RESOURCE);
  for (const [key, value] of Object.entries(options.identityQuery ?? {})) {
    if (value) url.searchParams.set(key, value);
  }

  const res = await fetch(url, { headers: { Metadata: "true" } });
  if (!res.ok) {
    // Deliberately does not include the response body: IMDS error bodies
    // can echo back request details, and this error may end up logged.
    throw new ImdsError(res.status, `IMDS token request failed with status ${res.status}`);
  }

  const body = (await res.json().catch(() => undefined)) as { access_token?: unknown } | undefined;
  if (typeof body?.access_token !== "string" || body.access_token.length === 0) {
    throw new ImdsError(res.status, "IMDS response did not include an access_token");
  }
  return body.access_token;
}

/**
 * Agent-side `managed_identity` attestation method.
 *
 * ASSUMED INTERFACE, FLAGGED FOR RECONCILIATION: unit 3 owns `apps/agent/
 * src/attestation.ts`, the orchestrator expected to dispatch to a
 * method-keyed object like this one at boot (mirroring its own
 * join-token method). It had not landed on the branch this unit forked
 * from, so `{ method, acquireCredential }` is this unit's best-effort guess
 * at that shape — a plain object rather than an Effect `Context.Tag`,
 * since the agent (unlike the control plane) does not depend on `effect` at
 * all (docs/spec.md §25: "stdlib-equivalent HTTP, one JWT library, no
 * framework" — kept thin deliberately). Reconcile at merge if unit 3's
 * dispatcher expects a different shape.
 *
 * Bare metal (spec §9's third, unimplemented `AttestationMethod`) would plug
 * in here the same way: `{ method: "bare_metal", acquireCredential }`
 * reading from wherever a bare-metal box's credential material lives — no
 * change to the orchestrator's dispatch needed.
 */
export const managedIdentityAttestation = {
  method: "managed_identity" as const,
  acquireCredential: acquireManagedIdentityCredential,
};
