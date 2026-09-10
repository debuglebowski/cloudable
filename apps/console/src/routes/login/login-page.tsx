import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, Cloud, History, Loader2, ShieldCheck, UserCheck } from "lucide-react";
import type * as React from "react";
import { useState } from "react";

import { useSignInMutation, useSignInSsoMutation, useSsoProviderQuery } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthError } from "@/lib/auth-client";
import { safeRedirectTarget } from "@/lib/redirect-target";

/** Where a successful sign-in lands — `root.tsx`'s guard sets this when it bounced an unauthenticated visit through here; falls back to `/` when there wasn't one, or when the value isn't a safe same-origin path (see `safeRedirectTarget`). */
function redirectTarget(): string {
  return safeRedirectTarget(window.location.search);
}

const TRUST_POINTS = [
  {
    icon: ShieldCheck,
    text: "Federated identity only — no cloud credential is ever stored.",
  },
  {
    icon: History,
    text: "Every event is append-only. Nothing is ever edited or deleted.",
  },
  {
    icon: UserCheck,
    text: "Exactly one owner per machine, always a person.",
  },
] as const;

/** Small square brand mark reused by both the dark panel and the mobile fallback header below. */
function BrandMark({ tone }: { tone: "on-dark" | "on-page" }) {
  return (
    <span
      className={
        tone === "on-dark"
          ? "flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white"
          : "flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background"
      }
    >
      <Cloud className="size-4" strokeWidth={2.25} />
    </span>
  );
}

/**
 * Left brand panel — deliberately a fixed dark navy rather than a token-driven
 * surface: it's decorative copy, not app chrome, so it doesn't need to track the
 * light/dark toggle the rest of the console respects. Hidden below `lg`; on
 * narrow viewports the mobile brand row in the form panel covers identity instead.
 */
function BrandPanel() {
  return (
    <div
      className="relative hidden flex-col justify-between overflow-hidden p-10 lg:flex lg:p-14"
      style={{
        backgroundColor: "hsl(222 25% 10%)",
        backgroundImage:
          "radial-gradient(ellipse 60% 50% at 20% -10%, hsl(216 70% 45% / 0.35), transparent 60%), radial-gradient(hsl(0 0% 100% / 0.06) 1px, transparent 1px)",
        backgroundSize: "auto, 24px 24px",
      }}
    >
      <div className="flex items-center gap-2.5">
        <BrandMark tone="on-dark" />
        <span className="text-base font-semibold tracking-tight text-white">Cloudable</span>
      </div>

      <div className="max-w-md">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight text-white">
          Persistent, governed cloud Linux machines.
        </h1>
        <p className="mt-4 max-w-sm text-base text-white/70">
          One per person, provisioned from identity, controlled by policy, evidenced for audit.
        </p>
        <ul className="mt-10 flex flex-col gap-4">
          {TRUST_POINTS.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white">
                <Icon className="size-4" strokeWidth={2} />
              </span>
              <span className="text-sm leading-snug text-white/80">{text}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-xs text-white/40">Azure only · Open source · MIT licensed</p>
    </div>
  );
}

/**
 * Email/password sign-in against BetterAuth's real `emailAndPassword`
 * provider (`apps/control-plane/src/auth.ts`), plus — when an org has
 * connected an identity provider (`GET /api/v1/auth/sso-provider`) — a
 * "Sign in with SSO" button that starts the real SAML flow, matching this
 * build's actual auth surface exactly rather than implying more than what's
 * wired. `root.tsx`'s route guard sends every unauthenticated request here
 * (preserving where it was headed via `?redirect=`) and bounces an
 * already-authenticated visit to this route straight back there, then back
 * there again on successful sign-in.
 */
export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useSignInMutation();
  const ssoProvider = useSsoProviderQuery();
  const ssoMutation = useSignInSsoMutation();
  const navigate = useNavigate();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email || !password || mutation.isPending) return;
    const [to, query] = redirectTarget().split("?");
    mutation.mutate(
      { email, password },
      {
        onSuccess: () =>
          query
            ? navigate({ to: to || "/", search: Object.fromEntries(new URLSearchParams(query)) })
            : navigate({ to: to || "/" }),
      },
    );
  }

  function handleSsoClick() {
    if (!ssoProvider.data?.providerId || ssoMutation.isPending) return;
    ssoMutation.mutate(
      {
        providerId: ssoProvider.data.providerId,
        callbackURL: `${window.location.origin}${redirectTarget()}`,
      },
      { onSuccess: (url) => window.location.assign(url) },
    );
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <BrandPanel />

      <div
        className="relative flex flex-col items-center justify-center bg-background px-6 py-12"
        style={{
          backgroundImage: "radial-gradient(hsl(var(--foreground) / 0.06) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      >
        <div className="w-full max-w-sm">
          <div className="mb-10 flex items-center gap-2.5 lg:hidden">
            <BrandMark tone="on-page" />
            <span className="text-base font-semibold tracking-tight">Cloudable</span>
          </div>

          <div className="mb-8">
            <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Sign in to your organisation's Cloudable console.
            </p>
          </div>

          <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                placeholder="you@company.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-10"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-10"
              />
            </div>
            {mutation.isError && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                <span>
                  {mutation.error instanceof AuthError
                    ? mutation.error.message
                    : "Something went wrong."}
                </span>
              </div>
            )}
            <Button type="submit" disabled={mutation.isPending} size="lg" className="mt-1 w-full">
              {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
              {mutation.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          {ssoProvider.data?.available && (
            <div className="mt-5 flex flex-col gap-3">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                or
                <div className="h-px flex-1 bg-border" />
              </div>
              {ssoMutation.isError && (
                <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>
                    {ssoMutation.error instanceof AuthError
                      ? ssoMutation.error.message
                      : "Something went wrong."}
                  </span>
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="w-full"
                disabled={ssoMutation.isPending}
                onClick={handleSsoClick}
              >
                {ssoMutation.isPending && <Loader2 className="size-4 animate-spin" />}
                {ssoMutation.isPending ? "Redirecting…" : "Sign in with SSO"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
