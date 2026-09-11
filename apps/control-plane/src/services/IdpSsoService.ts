import { authAccount, authSsoProvider } from "@cloudable/schema";
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";
import { auth, authDb } from "../auth";
import { entryPointFrom, looksLikeSamlMetadata, spIssuer } from "./saml-metadata";

/**
 * Bridges the `idp` integration row (`domain/integrations/integrations.ts`)
 * to BetterAuth's `@better-auth/sso` plugin (`../auth.ts`) — connecting or
 * disconnecting the integration registers or removes the matching real SAML
 * provider, so the console's "Connect Microsoft Entra ID" button actually
 * enables sign-in, not just storage. Called from
 * `http/handlers/integrations.ts`, never from `domain/integrations/
 * integrations.ts` itself — that module stays a pure DB layer.
 *
 * `providerId` is always the `idp` integration row's own id: single-slot per
 * org (see that module's header comment), so each connect gets a fresh id
 * and each disconnect/reconnect needs its own register/delete pair — never
 * reused across rows.
 */
export class IdpSsoError extends Data.TaggedError("IdpSsoError")<{
  reason: "metadata_unreachable" | "metadata_invalid" | "register_failed";
  cause?: unknown;
}> {}

export const registerSamlProvider = (input: {
  providerId: string;
  metadataUrl: string;
  headers: Headers;
}): Effect.Effect<void, IdpSsoError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(input.metadataUrl),
      catch: (cause) => new IdpSsoError({ reason: "metadata_unreachable", cause }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new IdpSsoError({ reason: "metadata_unreachable", cause: response.status }),
      );
    }
    const metadata = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new IdpSsoError({ reason: "metadata_unreachable", cause }),
    });
    if (!looksLikeSamlMetadata(metadata)) {
      return yield* Effect.fail(new IdpSsoError({ reason: "metadata_invalid" }));
    }
    const entryPoint = entryPointFrom(metadata);
    if (!entryPoint) {
      return yield* Effect.fail(new IdpSsoError({ reason: "metadata_invalid" }));
    }

    yield* Effect.tryPromise({
      try: () =>
        auth.api.registerSSOProvider({
          headers: input.headers,
          body: {
            providerId: input.providerId,
            issuer: spIssuer(),
            // `@better-auth/sso`'s `domain` field is "the email domain of
            // the provider, used for email/domain-based sign-in matching" —
            // meaningless here since sign-in only ever resolves this
            // provider by `providerId` (see `login-page.tsx`), but the
            // column is NOT NULL and the register endpoint stores whatever
            // it's given verbatim, with no fallback of its own. `.invalid`
            // is RFC 2606's reserved TLD for exactly this — guaranteed
            // never to resolve or collide with a real domain.
            domain: `${input.providerId}.invalid`,
            samlConfig: { entryPoint, idpMetadata: { metadata } },
          },
        }),
      catch: (cause) => new IdpSsoError({ reason: "register_failed", cause }),
    });
  });

/**
 * Direct delete against `auth_sso_provider`/`auth_account`, not
 * `auth.api.deleteSSOProvider` — that endpoint gates on `provider.userId ===
 * (the calling session's user id)` (no "organization" plugin installed here
 * to widen that to "any org admin"), so a different admin than whoever
 * originally connected the integration would get a 403 the caller of this
 * function has no way to react to. Cloudable's own `CurrentUserAuthentication`
 * already authorized this disconnect at the HTTP layer; BetterAuth's
 * per-user ownership model doesn't apply to an org-level integration.
 * Mirrors that endpoint's own cleanup (both tables), just without its
 * ownership check.
 */
export const deleteSamlProvider = (providerId: string): Effect.Effect<void, never> =>
  Effect.tryPromise(() =>
    authDb.transaction(async (tx) => {
      await tx.delete(authAccount).where(eq(authAccount.providerId, providerId));
      await tx.delete(authSsoProvider).where(eq(authSsoProvider.providerId, providerId));
    }),
  ).pipe(Effect.catchAll(() => Effect.void));

/**
 * Used by `GET /api/v1/auth/sso-provider` (the login page's "should I show
 * a button" check) to confirm an `idp` integration row actually has a real
 * SAML provider behind it before pointing a signed-out visitor at it —
 * connect-time registration failure already rolls the integration row back
 * (see `http/handlers/integrations.ts`), but this is cheap insurance against
 * drift between the two tables however it might happen.
 */
export const isSamlProviderRegistered = (providerId: string): Effect.Effect<boolean, never> =>
  Effect.tryPromise(() =>
    authDb
      .select({ id: authSsoProvider.id })
      .from(authSsoProvider)
      .where(eq(authSsoProvider.providerId, providerId))
      .limit(1),
  ).pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.catchAll(() => Effect.succeed(false)),
  );
