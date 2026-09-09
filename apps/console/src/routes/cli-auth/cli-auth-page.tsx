import { AlertCircle, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { apiPost } from "@/lib/api-client";

/**
 * `cloudable login`'s browser handoff target — reached only via that CLI
 * process opening this URL with `?callbackPort=<port>&state=<state>` (see
 * `apps/cli/src/login.ts`'s `obtainCliAuthCode`). `root.tsx`'s usual session
 * guard runs first: an unauthenticated visit detours through `/login`
 * (email/password, or "Sign in with SSO" once an org has connected one) and
 * back here with the same query preserved, so by the time this renders
 * there's always a real session.
 *
 * Once signed in, this mints a short-lived code
 * (`POST /api/v1/cli-auth/code`, session-gated) and does a full-page
 * redirect to the CLI's own localhost callback server — never a fetch, the
 * whole point is to hand the code to a different process.
 */
export function CliAuthPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const callbackPort = params.get("callbackPort");
    const state = params.get("state");
    if (!callbackPort || !state) {
      setError("Missing callback details — reopen this page from `cloudable login`.");
      return;
    }

    let cancelled = false;
    apiPost<{ code: string }>("/api/v1/cli-auth/code")
      .then(({ code }) => {
        if (cancelled) return;
        window.location.replace(
          `http://127.0.0.1:${callbackPort}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Something went wrong.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center">
      {error ? (
        <div className="flex max-w-sm items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : (
        <>
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Signing in to the CLI…</p>
        </>
      )}
    </div>
  );
}
