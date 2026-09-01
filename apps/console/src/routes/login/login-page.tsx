import { useNavigate } from "@tanstack/react-router";
import { Cloud } from "lucide-react";
import type * as React from "react";
import { useState } from "react";

import { useSignInMutation } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthError } from "@/lib/auth-client";

/**
 * Plain email/password sign-in against BetterAuth's real
 * `emailAndPassword` provider (`apps/control-plane/src/auth.ts`) — no
 * OAuth/SSO button, no "forgot password" flow, matching this build's
 * actual auth surface exactly rather than implying one that doesn't exist.
 * `root.tsx`'s route guard sends every unauthenticated request here (and
 * bounces an already-authenticated visit to this route straight back to
 * `/`), then back to `/` again on successful sign-in.
 */
export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useSignInMutation();
  const navigate = useNavigate();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email || !password || mutation.isPending) return;
    mutation.mutate({ email, password }, { onSuccess: () => navigate({ to: "/" }) });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <span className="mb-2 flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Cloud className="size-5" strokeWidth={2.25} />
          </span>
          <CardTitle>Sign in to Cloudable</CardTitle>
          <CardDescription>Persistent, governed cloud Linux machines.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
              />
            </div>
            {mutation.isError && (
              <p className="text-sm text-destructive">
                {mutation.error instanceof AuthError
                  ? mutation.error.message
                  : "Something went wrong."}
              </p>
            )}
            <Button type="submit" disabled={mutation.isPending} className="mt-1">
              {mutation.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
