import { DefaultAzureCredential } from "@azure/identity";
import type * as schema from "@cloudable/schema";
import { machines } from "@cloudable/schema";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Effect } from "effect";
import { type JWTPayload, createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
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
 * for this credential — the same principle as `sub` for the (removed) OIDC
 * federation flow (docs/cloud-auth.md: "the subject binding is the tenant
 * isolation boundary. A trust rule naming only the issuer accepts a token
 * minted for any customer."). Checked against *this deployment's own*
 * Azure tenant (`resolveOwnTenantId` below) so a signature-valid token
 * minted by some *other* Azure AD tenant is rejected here, at verification
 * time — not just incidentally by some unrelated downstream lookup.
 */
const MANAGED_IDENTITY_TENANT_CLAIM = "tid";

/** GUIDs are case-insensitive; trims incidental whitespace too — see the tenant-pinning comparison's own comment for why. */
const normalizeTenantId = (value: string): string => value.trim().toLowerCase();

let cachedOwnTenantId: string | null | undefined;

/**
 * The Azure AD tenant *this control plane's own managed identity* lives in —
 * resolved once, ambiently, from the same credential
 * `ProvisioningService.azure.ts`'s `getClients()` already uses
 * (`DefaultAzureCredential()`), then cached in-process.
 *
 * Replaces a per-org `integrations.config.tenantId` lookup that used to live
 * here: that was part of the federated (BYOC) multi-tenant design
 * `docs/cloud-auth.md` documents as explicitly **removed** ("The
 * customer-federated (BYOC) path — removed... Enabling Azure for an org is
 * therefore a plain policy toggle, not a connection... no tenant ID, no
 * application ID, no subscription ID"). Nothing was ever built to populate
 * that per-org field — no UI field on the Integrations page, no write path
 * anywhere in `domain/integrations/integrations.ts` — so it was always
 * `null`, and tenant pinning failed closed for every single machine on
 * every real (self-hosted, single-tenant) deployment: confirmed live,
 * `tenant_mismatch` on every attestation attempt. Since this deployment
 * only ever has one Azure tenant — its own — that's also the only
 * meaningful thing to check a token against, and it needs no admin input at
 * all to know: it's the same ambient fact `DefaultAzureCredential()` already
 * resolves for every other Azure call this control plane makes.
 *
 * Never fails — a transient resolution problem (network blip, IMDS not
 * reachable) degrades to `null`, which `verifyCredential` already treats as
 * "reject" (fail closed), same as an org's never-configured tenant used to.
 */
const resolveOwnTenantId = (): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if (cachedOwnTenantId !== undefined) return cachedOwnTenantId;

    const resolved = yield* Effect.tryPromise({
      try: async () => {
        const credential = new DefaultAzureCredential();
        const token = await credential.getToken(`${config.managedIdentityAudience}.default`);
        if (!token) return null;
        const tid = decodeJwt(token.token)[MANAGED_IDENTITY_TENANT_CLAIM];
        return typeof tid === "string" && tid.length > 0 ? tid : null;
      },
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));

    cachedOwnTenantId = resolved;
    return resolved;
  });

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
   * Resolves the one Azure AD tenant id every machine token is expected to
   * present — this deployment's own (see `resolveOwnTenantId`). `null`
   * means it couldn't be resolved, which is treated as a rejection (fail
   * closed), not as "skip the check". Injected, like `resolveMachine`, so
   * this is unit-testable without hitting a real IMDS endpoint.
   */
  readonly resolveExpectedTenantId: Effect.Effect<string | null>;
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
      // resolves to a real machine can still have been minted by some
      // *other* Azure AD tenant — `resolveMachine`'s `xms_mirid` lookup
      // says nothing about which tenant issued the token (Azure resource
      // ids across different subscriptions can't collide, but this check
      // costs nothing and rejects a bad token at verification time instead
      // of relying on that alone). Reject here, rather than letting a
      // tenant mismatch slip through and only ever get caught by an
      // unrelated downstream check.
      const tid = payload[MANAGED_IDENTITY_TENANT_CLAIM];
      const expectedTenantId = yield* options.resolveExpectedTenantId;
      if (
        typeof tid !== "string" ||
        tid.length === 0 ||
        expectedTenantId === null ||
        // Azure AD tenant ids are GUIDs — case-insensitive by definition.
        // Comparing normalized avoids a spurious mismatch over stray
        // whitespace or casing that both still name the exact same tenant.
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
 * Looks up the machine owning a given Azure resource id — extracted and
 * exported (rather than an inline closure) so it's directly testable against
 * a real database without needing a signed JWT to drive it through
 * `verifyCredential`.
 *
 * Case-insensitive on purpose: Azure resource ids are case-insensitive by
 * definition, but different ARM operations echo them back with different
 * casing for the same real resource — confirmed live: an IMDS-issued token's
 * `xms_mirid` claim reads "resourcegroups" (all lowercase), while
 * `virtualMachines.get`/`.list()` (ARM read paths) return "resourceGroups".
 * A plain `eq()` here is exact-string, so it silently never matches whichever
 * machines had their `externalResourceId` recorded via a differently-cased
 * ARM response than the one IMDS happens to issue at attestation time — this
 * masqueraded as `unknown_machine` in production.
 */
export const resolveMachineByResourceId = (
  db: PostgresJsDatabase<typeof schema>,
  resourceId: string,
): Effect.Effect<MachineIdentity, AttestationError> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(machines)
          .where(sql`lower(${machines.externalResourceId}) = lower(${resourceId})`)
          .limit(1),
      catch: (cause) => new AttestationError({ reason: "lookup_failed", cause }),
    });

    const machine = rows[0];
    if (!machine) {
      return yield* Effect.fail(new AttestationError({ reason: "unknown_machine" }));
    }

    return { machineId: machine.id, orgId: machine.orgId } satisfies MachineIdentity;
  });

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

        return yield* resolveMachineByResourceId(db, resourceId);
      });

    return makeManagedIdentityAttestation({
      jwksUrl: config.managedIdentityJwksUrl,
      audience: config.managedIdentityAudience,
      resolveMachine,
      resolveExpectedTenantId: resolveOwnTenantId(),
    });
  });
