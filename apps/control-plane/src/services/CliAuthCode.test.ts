import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { issueCliAuthCode, verifyCliAuthCode } from "./CliAuthCode";

describe("CliAuthCode", () => {
  test("issued code round-trips through verifyCliAuthCode", () => {
    const code = issueCliAuthCode({ personId: "person-1", orgId: "org-1" });
    const result = verifyCliAuthCode(code);
    expect(result).toEqual({ ok: true, personId: "person-1", orgId: "org-1" });
  });

  test("rejects a garbage code as malformed", () => {
    const result = verifyCliAuthCode("this-is-not-a-real-code");
    expect(result).toEqual({ ok: false, error: { reason: "malformed_code" } });
  });

  test("rejects an empty string", () => {
    expect(verifyCliAuthCode("")).toEqual({ ok: false, error: { reason: "malformed_code" } });
  });

  test("rejects a code with a tampered signature", () => {
    const code = issueCliAuthCode({ personId: "person-1", orgId: "org-1" });
    const tampered = `${code.slice(0, -4)}AAAA`;
    expect(verifyCliAuthCode(tampered)).toEqual({
      ok: false,
      error: { reason: "invalid_signature" },
    });
  });

  test("rejects a code signed under a different secret", () => {
    const code = issueCliAuthCode({ personId: "person-1", orgId: "org-1" });
    const previous = process.env.CLI_AUTH_CODE_SECRET;
    process.env.CLI_AUTH_CODE_SECRET = "a-different-secret";
    try {
      expect(verifyCliAuthCode(code)).toEqual({
        ok: false,
        error: { reason: "invalid_signature" },
      });
    } finally {
      if (previous === undefined) process.env.CLI_AUTH_CODE_SECRET = undefined;
      else process.env.CLI_AUTH_CODE_SECRET = previous;
    }
  });

  test("rejects an expired code", () => {
    const code = issueCliAuthCode({ personId: "person-1", orgId: "org-1" });
    const [purpose, body] = code.split(".");
    const payload = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8"));
    payload.iat = Date.now() - 61_000;
    const tamperedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
    // Re-sign with the real secret so this exercises the TTL check specifically,
    // not signature rejection — the same `secret()`/`sign()` scheme as CliAuthCode.ts.
    const sign = (data: string) =>
      crypto
        .createHmac("sha256", process.env.CLI_AUTH_CODE_SECRET ?? "dev-only-change-me")
        .update(data)
        .digest("base64url");
    const expiredCode = `${purpose}.${tamperedBody}.${sign(`${purpose}.${tamperedBody}`)}`;
    expect(verifyCliAuthCode(expiredCode)).toEqual({ ok: false, error: { reason: "expired" } });
  });
});
