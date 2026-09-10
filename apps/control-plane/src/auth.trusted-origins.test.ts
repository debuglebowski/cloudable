import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * BetterAuth's `trustedOrigins` REPLACES its default (baseURL) rather than
 * extending it, so any explicit list that omits `betterAuthUrl` silently stops
 * the deployment trusting its own origin.
 *
 * That happened: the list was `[config.consoleOrigin]`, `consoleOrigin`
 * defaults to the dev server on localhost:5180, and nothing sets
 * CONSOLE_ORIGIN in production — so production trusted exactly one origin that
 * never appears in a real request. Email/password sign-in did not care;
 * SSO did, because it validates `callbackURL` against this list, and every
 * attempt failed with "Invalid callbackURL".
 *
 * A source-text assertion rather than a runtime one because importing
 * `auth.ts` constructs a BetterAuth instance and a Postgres pool at module
 * load, which needs a live database — far too much to stand up for a
 * one-line invariant.
 */
const AUTH_SRC = readFileSync(join(import.meta.dir, "auth.ts"), "utf8");

describe("betterauth trustedOrigins", () => {
  it("includes betterAuthUrl, since setting it replaces the default", () => {
    const line = AUTH_SRC.split("\n").find((l) => l.trimStart().startsWith("trustedOrigins:"));

    expect(line).toBeDefined();
    expect(line).toContain("config.betterAuthUrl");
  });
});
