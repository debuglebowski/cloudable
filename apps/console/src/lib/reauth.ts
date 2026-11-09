import { apiGet } from "@/lib/api-client";
import { signInSso } from "@/lib/auth-client";

const LAST_ATTEMPT_KEY = "cloudable.idpReauthAt";
/** A second demand inside this window means the round trip did not help: stop and show /login. */
const LOOP_GUARD_MS = 60_000;

let inFlight = false;

/**
 * Starts a fresh SSO sign-in that comes back to the page the person is on. Used when the control
 * plane answers `idp_reauthentication_required` (roles from the identity provider, role evidence
 * past its recheck deadline). The sign-in is a new SAML assertion; the identity provider usually
 * answers it from its own open session, so the person sees a brief redirect, not a prompt.
 *
 * Runs once at a time, and at most once a minute: if the control plane still refuses straight
 * after a round trip, `onGiveUp` sends the person to `/login` with the reason instead of
 * bouncing them between the IdP and the console.
 */
export async function startIdpReauth(onGiveUp: (reason: string) => void): Promise<void> {
  if (inFlight) return;
  const last = Number(window.sessionStorage.getItem(LAST_ATTEMPT_KEY) ?? 0);
  if (Date.now() - last < LOOP_GUARD_MS) {
    onGiveUp("Your identity provider did not confirm your Cloudable role. Sign in again.");
    return;
  }
  inFlight = true;
  try {
    window.sessionStorage.setItem(LAST_ATTEMPT_KEY, String(Date.now()));
    const status = await apiGet<{ providerId: string | null }>("/api/v1/auth/sso-provider");
    if (!status.providerId) {
      onGiveUp("Sign in through your identity provider.");
      return;
    }
    const back = window.location.pathname + window.location.search;
    const url = await signInSso(status.providerId, `${window.location.origin}${back}`);
    window.location.assign(url);
  } catch {
    onGiveUp("Could not start sign-in with your identity provider.");
  } finally {
    inFlight = false;
  }
}
