import { integrations, machines } from "@cloudable/schema";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../../config";
import { Db } from "../../db/layer";
import {
  AttestationError,
  type AttestationMethod,
  type MachineIdentity,
} from "./AttestationMethod";

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
 * Azure AD tenant id claim, present on every Entra ID token including
 * IMDS-issued managed-identity ones. This is the tenant isolation boundary
 * for this credential — the same principle as `sub` for the OIDC
 * federation flow (docs/cloud-auth.md: "the subject binding is the tenant
 * isolation boundary. A trust rule naming only the issuer accepts a token
 * minted for any customer."). Checked against the target org's own
 * configured Azure tenant (`resolveExpectedTenantId` below) so a
 * signature-valid token minted by the *wrong* Azure AD tenant is rejected
 * here, at verification time — not just incidentally by some unrelated
 * downstream lookup.
 */
const MANAGED_IDENTITY_TENANT_CLAIM = "tid";

/** GUIDs are case-insensitive; trims incidental whitespace too — see the tenant-pinning comparison's own comment for why. */
const normalizeTenantId = (value: string): string => value.trim().toLowerCase();

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
  /**
   * Resolves the Azure AD tenant id (`tid`) the given org's machines are
   * expected to present — sourced from that org's connected `cloud`
   * integration (`integrations.config.tenantId`, set when an org admin
   * connects Azure via the console's Integrations page — see
   * `domain/integrations/integrations.ts`). `null` means the org has no
   * such tenant configured, which is treated as a rejection (fail closed),
   * not as "skip the check". Injected, like `resolveMachine`, so this is
   * unit-testable without a database.
   */
  readonly resolveExpectedTenantId: (
    orgId: string,
  ) => Effect.Effect<string | null, AttestationError>;
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
      // `aud` and signature are checked against the shared multi-tenant
      // "common" Azure AD JWKS — Azure AD's signing keys are shared across
      // every tenant, so this alone verifies a managed-identity token from
      // ANY Azure AD tenant with the right audience. The `tid` check right
      // below is what pins it to the *target org's* own tenant — the same
      // principle docs/cloud-auth.md requires for the OIDC federation flow
      // ("a trust rule naming only the issuer accepts a token minted for
      // any customer").
      const { payload } = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(credential, jwks, {
            audience: options.audience,
            algorithms: ["RS256"],
          }),
        // No `cause` set here — see `classifyJwtError`'s doc comment.
        catch: (cause) => new AttestationError({ reason: classifyJwtError(cause) }),
      });

      const identity = yield* options.resolveMachine(payload);

      // Tenant pinning: a token that's signature-valid and correctly
      // resolves to a real machine can still have been minted by the
      // *wrong* Azure AD tenant — `resolveMachine`'s `xms_mirid` lookup
      // says nothing about which tenant issued the token. Reject here,
      // at verification time, rather than letting a tenant mismatch slip
      // through and only ever get caught by an unrelated downstream check.
      const tid = payload[MANAGED_IDENTITY_TENANT_CLAIM];
      const expectedTenantId = yield* options.resolveExpectedTenantId(identity.orgId);
      if (
        typeof tid !== "string" ||
        tid.length === 0 ||
        expectedTenantId === null ||
        // Azure AD tenant ids are GUIDs — case-insensitive by definition —
        // and `expectedTenantId` is whatever an org admin typed into a plain
        // text field on the console's Integrations page (see
        // `connect-dialogs.tsx`). Comparing normalized avoids permanently
        // locking out a whole org's machines over stray whitespace or casing
        // that both still name the exact same tenant.
        normalizeTenantId(tid) !== normalizeTenantId(expectedTenantId)
      ) {
        return yield* Effect.fail(
          new AttestationError({
            reason: "tenant_mismatch",
            claimedOrgId: identity.orgId,
            claimedMachineId: identity.machineId,
          }),
        );
      }

      return identity;
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
export const managedIdentityAttestationEffect: Effect.Effect<AttestationMethod, never, Db> =
  Effect.gen(function* () {
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

    // The org's connected `cloud` integration (console Integrations page,
    // `domain/integrations/integrations.ts`) is the one place an Azure
    // tenant id is recorded per org — `config.tenantId` on the live
    // (non-removed) `kind: "cloud"` row. `null` (no such row, or no
    // `tenantId` in its config) fails closed in `verifyCredential` above,
    // it does not skip the check.
    const resolveExpectedTenantId = (
      orgId: string,
    ): Effect.Effect<string | null, AttestationError> =>
      Effect.gen(function* () {
        const rows = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(integrations)
              .where(
                and(
                  eq(integrations.orgId, orgId),
                  eq(integrations.kind, "cloud"),
                  isNull(integrations.removedAt),
                ),
              )
              .limit(1),
          catch: (cause) => new AttestationError({ reason: "lookup_failed", cause }),
        });

        const row = rows[0];
        if (!row) return null;
        const tenantId = (row.config as Record<string, unknown> | null)?.tenantId;
        return typeof tenantId === "string" && tenantId.length > 0 ? tenantId : null;
      });

    return makeManagedIdentityAttestation({
      jwksUrl: config.managedIdentityJwksUrl,
      audience: config.managedIdentityAudience,
      resolveMachine,
      resolveExpectedTenantId,
    });
  });
