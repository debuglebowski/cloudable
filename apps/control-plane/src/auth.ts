import { sso } from "@better-auth/sso";
import {
  authAccount,
  authSession,
  authSsoProvider,
  authUser,
  authVerification,
  people,
} from "@cloudable/schema";
import type { BetterAuthOptions } from "better-auth";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { CONFIGURED_IDP_PROVIDER_ID, config } from "./config";
import { openPostgres } from "./db/connect";
import { spIssuer } from "./services/saml-metadata";

// BetterAuth baseline: email/password, plus SAML SSO via `@better-auth/sso`
// (`sso()` with no top-level `saml`/`oidc` config — every real provider's
// trust config comes from a per-org `registerSSOProvider` call instead, see
// `services/IdpSsoService.ts`). SAML, never OIDC: the Integrations
// page's IdP connect form only ever collects a federation metadata URL and
// deliberately never a client secret (`connect-dialogs.tsx`'s
// `IdpConnectDialog`) — SAML's cert-based trust fits that; OIDC's
// confidential-client flow would need a stored secret. Full multi-IdP OIDC
// federation (per docs/cloud-auth.md) remains out of scope — that doc
// covers a different, removed feature (Azure BYOC cloud-credential
// federation), not user login.
//
// Deviation from the literal instruction to reuse "the same" connection as
// `db/layer.ts`'s `DbLive`: that connection is opened lazily inside a
// `Layer.scoped` Effect (only available once the Effect runtime boots),
// while BetterAuth needs a plain, synchronous db handle at module-load
// time. This opens a second `postgres()` connection pointed at the same
// `DATABASE_URL` instead — same database, different client instance. A
// future feature unit may thread the Effect-managed connection through the
// layer graph instead, if that turns out to matter.
const authSql = openPostgres();
/** Exported for `services/IdpSsoService.ts`'s direct `auth_sso_provider`/`auth_account` cleanup — see that file for why it bypasses the plugin's own (per-user-ownership-gated) delete endpoint. */
export const authDb = drizzle(authSql);

/**
 * Hand-picked surface of the real BetterAuth instance — every method this
 * codebase actually calls on `auth`, nothing more. `export const auth =
 * betterAuth({ ..., plugins: [sso()] })` directly, with no annotation,
 * fails `tsc -b`'s declaration emit with TS2742 ("inferred type of 'auth'
 * cannot be named without a reference to '.../zod/v4/core'") — the `sso`
 * plugin's endpoint types embed a private Zod v4 type that can't be printed
 * into a `.d.ts`. This is a known upstream better-auth+plugin limitation
 * (see e.g. better-auth/better-auth#1861, #4250), not fixable from this
 * config; naming an explicit, narrow interface for the export sidesteps it
 * instead of trying to print the SDK's full inferred type.
 */
interface AuthInstance {
  handler: (request: Request) => Promise<Response>;
  api: {
    getSession: (options: {
      headers: Headers;
    }) => Promise<{ user: { id: string; email: string } } | null>;
    signUpEmail: (options: {
      body: { email: string; password: string; name: string };
    }) => Promise<{ user: { id: string; email: string } }>;
    /**
     * `headers` must carry the connecting admin's own session cookie — this
     * endpoint requires one (`use` middleware), and forwarding the same
     * request's session is simpler and more correct than minting a separate
     * one. `issuer`/`domain` are optional in the SDK's own request type but
     * stored verbatim with no server-side fallback — omitting either would
     * insert `undefined` into a NOT NULL column, so `IdpSsoService.ts`
     * always supplies both; there is no delete counterpart here on purpose
     * (see that file).
     */
    registerSSOProvider: (options: {
      headers: Headers;
      body: {
        providerId: string;
        issuer: string;
        domain: string;
        samlConfig?: { idpMetadata?: { metadata?: string }; entryPoint?: string };
      };
    }) => Promise<{ providerId: string }>;
  };
}

/**
 * The SAML provider declared by deployment config, or `undefined` when this
 * deployment is console-driven (the default, and what local dev always is).
 *
 * Built here rather than fetched, because `auth.ts` is evaluated at module
 * load and there is nowhere to await: `server.ts` binds the HTTP listener
 * before the boot chain precisely so a slow startup cannot trip Azure
 * Container Apps' startup probe, and a network fetch on this path would put
 * that back. The metadata XML therefore arrives already fetched, via
 * `IDP_METADATA_XML` — see that config field for why Terraform is the right
 * place to do the fetching.
 */
const configuredIdp = (() => {
  const idp = config.idpSamlConfig;
  if (!idp) return undefined;

  return {
    providerId: CONFIGURED_IDP_PROVIDER_ID,
    // `@better-auth/sso`'s `domain` is for email-domain-based provider
    // matching, which this deployment never uses — sign-in always resolves
    // the provider by id (see `login-page.tsx`). `.invalid` is RFC 2606's
    // reserved TLD, guaranteed never to resolve or collide with a real
    // domain. Same reasoning as `IdpSsoService.ts`'s registration call.
    domain: `${CONFIGURED_IDP_PROVIDER_ID}.invalid`,
    samlConfig: {
      issuer: spIssuer(),
      entryPoint: idp.ssoUrl,
      // entityID + cert instead of the metadata XML: the plugin accepts
      // either, and the document is not stable enough to be configuration
      // (Entra regenerates its ID and Signature per request). Passing every
      // advertised certificate is what makes an IdP key rotation a non-event
      // — responses signed by any listed cert are accepted.
      idpMetadata: {
        entityID: idp.entityId,
        cert: [...idp.certs],
        singleSignOnService: [
          { Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect", Location: idp.ssoUrl },
        ],
      },
    },
  };
})();

const options = {
  // The drizzle adapter's own model names (`user`/`session`/`account`/
  // `verification`) are mapped explicitly to this build's `auth_`-prefixed
  // tables (`packages/schema/src/tables/auth-*.ts`) — those are named with
  // the prefix specifically to avoid colliding with the pre-existing
  // `sessions` table (SSH/terminal access) and the generic term "session"
  // being heavily overloaded elsewhere in this codebase, so the adapter
  // can't infer the mapping from `db._.fullSchema` by bare model name alone.
  database: drizzleAdapter(authDb, {
    provider: "pg",
    schema: {
      user: authUser,
      session: authSession,
      account: authAccount,
      verification: authVerification,
      ssoProvider: authSsoProvider,
    },
  }),
  secret: config.betterAuthSecret,
  baseURL: config.betterAuthUrl,
  plugins: [
    sso({
      // Adds `domainVerified` to the plugin's ssoProvider model (hence the
      // `domain_verified` column in `packages/schema`). Enabled for one
      // reason: a `defaultSSO` provider resolves as `domainVerified: true`,
      // which is what makes it a TRUSTED provider in BetterAuth's account
      // linking check. Without it, a SAML sign-in for an email that already
      // has a local account fails with "account not linked" and logs nothing
      // outside development — see the accountLinking comment below.
      domainVerification: { enabled: true },
      // The identity provider declared by deployment config, if there is one.
      //
      // `defaultSSO` is checked by the plugin's `findSAMLProvider` BEFORE the
      // database, so this needs no `auth_sso_provider` row and no boot-time
      // reconcile. It is also self-defending: `registerSSOProvider` refuses
      // any providerId that collides with a `defaultSSO` entry, so the
      // console physically cannot override what Terraform declared.
      //
      // Upstream's docstring calls this option "for testing". It is used here
      // deliberately and with that known — the code path is first-class, the
      // dependency is pinned at @better-auth/sso 1.7.2, and
      // `auth.default-sso.test.ts` fails loudly if the option stops being
      // accepted on an upgrade.
      ...(configuredIdp ? { defaultSSO: [configuredIdp] } : {}),
    }),
  ],
  // BetterAuth's own CSRF/origin check (separate from `HttpMiddleware.cors`
  // in server.ts) rejects any request that carries a session cookie unless
  // its `Origin` is in this list — every request after the very first
  // sign-in click, in practice. Without this, real browser sessions break
  // immediately after login (sign-out, and any later `/sign-in` retry,
  // all 403 "Invalid origin" the moment a cookie is already set).
  //
  // `betterAuthUrl` FIRST and unconditionally: setting this option REPLACES
  // BetterAuth's default (which is baseURL), it does not extend it. Listing
  // only `consoleOrigin` therefore stopped the deployment trusting its own
  // origin — and since consoleOrigin defaults to the dev server on
  // localhost:5180 and nothing sets CONSOLE_ORIGIN in production, the list
  // was exactly one origin that never appears in a real request. That is
  // invisible to email/password sign-in but fatal to SSO, which validates
  // `callbackURL` against this list: the console posts its own absolute
  // origin and got "Invalid callbackURL".
  //
  // In production both entries are the same origin (one container serves the
  // API and the console); in local dev they differ, which is the only reason
  // consoleOrigin is here at all. Deduped so the list stays honest either way.
  trustedOrigins: [...new Set([config.betterAuthUrl, config.consoleOrigin])],
  emailAndPassword: { enabled: true },
  account: {
    accountLinking: {
      // A SAML assertion for an email that already has a local password
      // account must be allowed to attach to it. BetterAuth otherwise
      // requires the LOCAL email to be verified first
      // (`oauth2/link-account.mjs`: `requireLocalEmailVerified &&
      // !dbUser.user.emailVerified`), and nothing in this deployment ever
      // verifies an email — there is no mail sending at all. The bootstrap
      // admin is therefore permanently unverified, so its owner could never
      // sign in through the IdP. Observed live: the SAML round trip
      // completed, linking was refused, and the console bounced back to
      // /login with no error anywhere, because that branch only warns
      // `if (isDevelopment())`.
      //
      // Safe here because of what the other half of that condition now
      // guarantees: the only trusted provider is the one declared in
      // deployment config, its assertions are signed by an IdP the operator
      // put in Terraform, and `databaseHooks` below still requires a
      // `people` row before any account is created. An assertion cannot
      // claim an email that is not already on the roster.
      requireLocalEmailVerified: false,
    },
  },
  // Root-cause fix for the class of bug that produced an orphaned
  // `dev@cloudable.local`: `emailAndPassword` sign-up on its own creates a
  // fully working BetterAuth account for any email, entirely independent of
  // `people` (an org's roster is admin/SCIM-managed — see
  // `domain/people/people.ts`'s doc comment — with no flow that ever links
  // the two at creation time). That account authenticates cleanly forever
  // but can never pass `CurrentUserAuthentication` (`http/middleware/
  // auth.ts`), since that middleware resolves the caller by matching this
  // same email against `people` — so it always 401s, no matter how many
  // times you sign in. Rather than patch that dead end after the fact,
  // reject the sign-up itself: no `people` row for this email, no account.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const [person] = await authDb
            .select({ id: people.id })
            .from(people)
            .where(eq(people.email, user.email))
            .limit(1);
          if (!person) {
            throw new APIError("BAD_REQUEST", {
              code: "no_matching_person",
              message: `No person record exists for "${user.email}". An org admin must add you as a person (People page) before you can sign in.`,
            });
          }
        },
      },
    },
  },
} satisfies BetterAuthOptions;

export const auth: AuthInstance = betterAuth(options);
