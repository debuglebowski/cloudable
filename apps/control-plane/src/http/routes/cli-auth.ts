import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Schema } from "effect";
import { CurrentUserAuthentication } from "../middleware/auth";

/**
 * `cloudable login`'s real identity handoff (`apps/cli/src/login.ts`) —
 * `POST /api/v1/cli-auth/code` is session-gated (the console's `/cli-auth`
 * page calls it with the browser's own cookie, after a real sign-in —
 * email/password or SSO) and mints a short-lived signed code
 * (`services/CliAuthCode.ts`) carrying `{ personId, orgId }`. The CLI's
 * local callback server receives that code over the redirect the console
 * page sends the browser to next, then exchanges it directly with
 * `issueCertificate` (`access.ts`) — no session cookie ever touches the CLI
 * process.
 */
const CliAuthCodeResponse = Schema.Struct({ code: Schema.String });

export const CliAuthGroup = HttpApiGroup.make("cliAuth")
  .add(HttpApiEndpoint.post("mintCode", "/api/v1/cli-auth/code").addSuccess(CliAuthCodeResponse))
  .middleware(CurrentUserAuthentication);
