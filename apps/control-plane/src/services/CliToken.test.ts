import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { CLI_TOKEN_TTL_MS, issueCliToken, verifyCliToken } from "./CliToken";

describe("CliToken", () => {
  test("issued token round-trips through verifyCliToken", () => {
    const token = issueCliToken({ personId: "person-1" });
    expect(verifyCliToken(token)).toEqual({ ok: true, personId: "person-1" });
  });

  test("rejects garbage and empty input as malformed", () => {
    expect(verifyCliToken("not-a-real-token")).toEqual({
      ok: false,
      error: { reason: "malformed_token" },
    });
    expect(verifyCliToken("")).toEqual({ ok: false, error: { reason: "malformed_token" } });
  });

  test("rejects a token with a tampered signature", () => {
    const token = issueCliToken({ personId: "person-1" });
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(verifyCliToken(tampered)).toEqual({
      ok: false,
      error: { reason: "invalid_signature" },
    });
  });

  /**
   * The escalation this format has to refuse: rewriting the subject to
   * someone else's person id and keeping the signature that came with the
   * original. The signature covers the claims bytes, so it cannot survive.
   */
  test("rejects a token whose personId was rewritten", () => {
    const token = issueCliToken({ personId: "person-1" });
    const [purpose, body, signature] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    claims.personId = "person-2-the-admin";
    const forgedBody = Buffer.from(JSON.stringify(claims)).toString("base64url");

    expect(verifyCliToken(`${purpose}.${forgedBody}.${signature}`)).toEqual({
      ok: false,
      error: { reason: "invalid_signature" },
    });
  });

  test("rejects a token signed under a different secret", () => {
    const previous = process.env.CLI_TOKEN_SECRET;
    process.env.CLI_TOKEN_SECRET = crypto.randomBytes(16).toString("hex");
    const token = issueCliToken({ personId: "person-1" });
    process.env.CLI_TOKEN_SECRET = crypto.randomBytes(16).toString("hex");

    expect(verifyCliToken(token)).toEqual({ ok: false, error: { reason: "invalid_signature" } });
    process.env.CLI_TOKEN_SECRET = previous;
  });

  /**
   * Signed, well-formed, but old. Built by hand rather than by waiting 30
   * days: `iat` is backdated past the TTL and then signed properly, so this
   * exercises the expiry check and not the signature check.
   */
  test("rejects an expired token, after the signature has already passed", () => {
    const secret = process.env.CLI_TOKEN_SECRET ?? "dev-only-change-me";
    const claims = {
      purpose: "cli-token",
      personId: "person-1",
      iat: Date.now() - CLI_TOKEN_TTL_MS - 1000,
    };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = crypto
      .createHmac("sha256", secret)
      .update(`cli-token.${body}`)
      .digest("base64url");

    expect(verifyCliToken(`cli-token.${body}.${signature}`)).toEqual({
      ok: false,
      error: { reason: "expired" },
    });
  });

  /** A `cloudable login` code must not be usable as a long-lived API credential. */
  test("rejects a token carrying another purpose", () => {
    const secret = process.env.CLI_TOKEN_SECRET ?? "dev-only-change-me";
    const claims = { purpose: "cli", personId: "person-1", orgId: "org-1", iat: Date.now() };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = crypto.createHmac("sha256", secret).update(`cli.${body}`).digest("base64url");

    expect(verifyCliToken(`cli.${body}.${signature}`)).toEqual({
      ok: false,
      error: { reason: "malformed_token" },
    });
  });
});
