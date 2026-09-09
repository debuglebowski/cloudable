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
import { config } from "./config";
import { openPostgres } from "./db/connect";

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
  plugins: [sso()],
  // BetterAuth's own CSRF/origin check (separate from `HttpMiddleware.cors`
  // in server.ts) rejects any request that carries a session cookie unless
  // its `Origin` is in this list — every request after the very first
  // sign-in click, in practice. Without this, real browser sessions break
  // immediately after login (sign-out, and any later `/sign-in` retry,
  // all 403 "Invalid origin" the moment a cookie is already set).
  trustedOrigins: [config.consoleOrigin],
  emailAndPassword: { enabled: true },
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
