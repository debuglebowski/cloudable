/**
 * Reads the `redirect` search param set by `routes/root.tsx`'s auth guard and
 * returns a safe, same-origin path to land on after sign-in.
 *
 * Two things this exists to prevent, both of which happened or nearly did:
 *
 * 1. **Double-encoding.** The guard used to `encodeURIComponent` the path
 *    before handing it to `Navigate`'s `search` prop, which encodes again.
 *    `URLSearchParams.get()` decodes exactly once, so "/integrations" came
 *    back as "%2Fintegrations" and `${origin}${that}` produced
 *    "https://host%2Fintegrations" — a mangled hostname, not a path. Every
 *    SSO sign-in failed with "Invalid callbackURL". Decoding defensively
 *    here means a stray extra layer degrades to "/" instead of breaking
 *    sign-in.
 *
 * 2. **Open redirect.** The param is attacker-controllable via a crafted
 *    link. A value like "//evil.com" is a protocol-relative URL, so
 *    `${origin}${value}` and a router `to` both send the user off-site.
 *    Only a single leading slash is accepted.
 */
export function safeRedirectTarget(search: string): string {
  const raw = new URLSearchParams(search).get("redirect");
  if (!raw) return "/";

  // A value still carrying %2F never came from a correctly-encoded param.
  // Treat it as untrustworthy rather than trying to guess the intent.
  const candidate = raw.includes("%") ? decodeURIComponent(raw) : raw;

  // Must be a path on this origin: one leading slash, and not "//host" or
  // "/\host" (browsers treat a backslash as a slash in authority position).
  if (!candidate.startsWith("/")) return "/";
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return "/";
  return candidate;
}
