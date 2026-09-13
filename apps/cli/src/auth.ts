// ---------------------------------------------------------------------------
// `cloudable logout` / `cloudable whoami` — what is left of the CLI's own
// account handling once `cloudable login` became the only way in.
//
// There used to be a `cloudable auth login` here that posted an email and a
// password to `/api/auth/sign-in/email` and kept the session cookie it got
// back. It is gone. Password sign-in is not: it moved to the browser, at the
// console's `/login`, which is where SSO is also on offer and which
// `cloudable login` already goes through. What that removed is a CLI that
// handles passwords — taken from argv, so from shell history and the process
// table, and checked against whatever host CLOUDABLE_API_URL happened to
// name. See `services/CliToken.ts` in the control plane for the credential
// that replaced the cookie.
// ---------------------------------------------------------------------------
import { parseArgs, readSpec } from "./args";
import { config } from "./config";
import { currentIdentity, fetchOrg } from "./identity";
import { printFields, printJson } from "./output";
import { clearSession, loadSession, requireSession } from "./session";

export function runLogoutCommand(): void {
  const existing = loadSession();
  clearSession();
  console.log(existing ? `Signed out ${existing.email}.` : "Not signed in.");
  // The certificate is not ours to clear: it lives in ssh-agent under its own
  // lifetime constraint and expires on its own within ~8 hours. `ssh-add -D`
  // is the way to drop it early, and dropping every other identity with it is
  // the user's call, not a side effect of signing out of an API.
}

/**
 * Asks the control plane rather than reading the file, so an expired or
 * revoked token fails here instead of being reported as signed in. `--local`
 * is the offline answer, for when you want to know which account is stored
 * without a round trip.
 */
export async function runWhoamiCommand(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv, readSpec({ booleans: ["local"] }));

  if (args.booleans.has("local")) {
    const session = requireSession();
    if (args.booleans.has("json")) {
      printJson({ email: session.email, apiUrl: config.apiUrl, live: false });
      return;
    }
    printFields([
      ["email", session.email],
      ["control plane", config.apiUrl],
    ]);
    return;
  }

  const identity = await currentIdentity();
  const org = await fetchOrg();

  if (args.booleans.has("json")) {
    printJson({ ...identity, org: { id: org.id, name: org.name }, apiUrl: config.apiUrl });
    return;
  }
  printFields([
    ["email", identity.email],
    ["person", identity.personId],
    ["role", identity.role],
    ["org", `${org.name} (${org.id})`],
    ["control plane", config.apiUrl],
  ]);
}
