import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { machines } from "@cloudable/schema";
import { config } from "../../config";
import { Db } from "../../db/layer";
import { type AttestationMethod, AttestationError, type MachineIdentity } from "./AttestationMethod";

/**
 * Azure claim carrying the managed identity's ARM resource id (`xms_mirid`)
 * on an IMDS-issued access token for a VM's system-assigned identity — e.g.
 * `/subscriptions/.../resourceGroups/.../providers/Microsoft.Compute/
 * virtualMachines/<name>`. This is what `machines.externalResourceId` is
 * populated with at provisioning time (see `ProvisioningService.azure.ts`),
 * so it's the natural join key back to a machine row.
 */
const MANAGED_IDENTITY_RESOURCE_CLAIM = "xms_mirid";

/**
 * Maps a `jose` verification failure to a fixed, safe reason string.
 *
 * Deliberately reads ONLY `error.code` — never `error.message` or
 * `error.cause` — because jose's own error codes are a small, non-secret
 * enum (e.g. `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`,
 * `ERR_JWKS_NO_MATCHING_KEY`), while some jose error messages/causes echo
 * back parts of the decoded JWT (claim names, claim values). This reason
 * ends up in the public `agent.attestation_failed` event payload and in
 * logs, so no part of the credential may reach it — see the unit's required
 * failure-path test in `managed-identity.test.ts`.
 */
const classifyJwtError = (cause: unknown): string => {
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && code.startsWith("ERR_") ? code : "invalid_credential";
};

export interface ManagedIdentityAttestationOptions {
  readonly jwksUrl: string;
  readonly audience: string;
  /** Resolves a verified token's claims to a machine identity — injected so this is unit-testable without a database. */
  readonly resolveMachine: (claims: JWTPayload) => Effect.Effect<MachineIdentity, AttestationError>;
}

/**
 * Builds the `managed_identity` `AttestationMethod` from its dependencies
 * directly (rather than only as an Effect `Layer`), so the JWKS-verification
 * logic is unit-testable against a local mock JWKS server without a real
 * database — `managedIdentityAttestationEffect` below supplies the real,
 * database-backed `resolveMachine`.
 */
export const makeManagedIdentityAttestation = (
  options: ManagedIdentityAttestationOptions,
): AttestationMethod => {
  // `createRemoteJWKSet` fetches lazily on first verification and caches the
  // key set in-process, re-fetching once if a `kid` isn't found in the
  // cached set — this is the "fetch and cache the JWKS" requirement.
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl));

  const verifyCredential: AttestationMethod["verifyCredential"] = (credential) =>
    Effect.gen(function* () {
      // KNOWN LIMITATION (flagged, not silently accepted): this only checks
      // `aud` and signature against the shared multi-tenant "common" Azure
      // AD JWKS — it does not pin a `tid`/issuer per org the way docs/
      // spec.md §10 requires for cloud federation ("a trust rule naming
      // only the issuer accepts a token minted for any customer"). A
      // managed-identity token from ANY Azure AD tenant with the right
      // audience verifies here; `resolveMachine`'s lookup by the
      // unforgeable `xms_mirid` claim, plus `attest()`'s claimed-vs-
      // resolved `orgId` check, are what actually prevent a token minted
      // for one org's VM from attesting as a different org's machine.
      // Proper per-org tenant pinning needs a place to store each org's
      // expected Azure tenant id — that's cloud-provider federation (spec
      // §10, unit 6's territory: `cloud.credential_federated` et al.), not
      // yet modeled in `orgs`/`integrations`. Tighten this once that lands.
      const { payload } = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(credential, jwks, {
            audience: options.audience,
            algorithms: ["RS256"],
          }),
        // No `cause` set here — see `classifyJwtError`'s doc comment.
        catch: (cause) => new AttestationError({ reason: classifyJwtError(cause) }),
      });
      return yield* options.resolveMachine(payload);
    });

  return {
    method: "managed_identity",
    // Azure issues managed-identity tokens via IMDS, not the control plane —
    // there is nothing for the control plane to mint here.
    issueCredential: (_claim) =>
      Effect.fail(
        new AttestationError({
          reason: "not_supported",
          cause: "managed_identity credentials are issued by Azure IMDS, not the control plane",
        }),
      ),
    verifyCredential,
  };
};

/**
 * The real, database-backed `managed_identity` `AttestationMethod`. Consumed
 * by `registry.ts`, which composes this Effect (and the other methods') into
 * the single `AttestationRegistryTag` layer.
 */
export const managedIdentityAttestationEffect: Effect.Effect<AttestationMethod, never, Db> = Effect.gen(
  function* () {
    const db = yield* Db;

    const resolveMachine = (claims: JWTPayload): Effect.Effect<MachineIdentity, AttestationError> =>
      Effect.gen(function* () {
        const resourceId = claims[MANAGED_IDENTITY_RESOURCE_CLAIM];
        if (typeof resourceId !== "string" || resourceId.length === 0) {
          return yield* Effect.fail(new AttestationError({ reason: "missing_identity_claim" }));
        }

        const rows = yield* Effect.tryPromise({
          try: () =>
            db.select().from(machines).where(eq(machines.externalResourceId, resourceId)).limit(1),
          catch: (cause) => new AttestationError({ reason: "lookup_failed", cause }),
        });

        const machine = rows[0];
        if (!machine) {
          return yield* Effect.fail(new AttestationError({ reason: "unknown_machine" }));
        }

        return { machineId: machine.id, orgId: machine.orgId } satisfies MachineIdentity;
      });

    return makeManagedIdentityAttestation({
      jwksUrl: config.managedIdentityJwksUrl,
      audience: config.managedIdentityAudience,
      resolveMachine,
    });
  },
);
