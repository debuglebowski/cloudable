import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Credential revocation for SSH rests on a fact this test keeps true: no machine trusts the
 * Cloudable SSH CA. Certificates (`services/ssh-ca/`) are issued and recorded, but sshd on a
 * machine is never told to accept them (`TrustedUserCAKeys`), machines take no inbound traffic
 * (the machines subnet's DenyAllInbound rule), and the tunnel's `ssh` method opens a PTY in the
 * tunnel daemon, behind the control plane's per-request credential check and the session sweep.
 * So a certificate issued before a refused sign-in or an activation reaches nothing, and revoking
 * the person's control-plane credentials revokes their access.
 *
 * Once a machine trusts the CA, an issued certificate authenticates offline until it expires, and
 * a TTL cap is not revocation. Whoever wires that trust must ship revocation with it (a KRL via
 * `RevokedKeys`, kept current from `certificates.revoked_at`). This test fails on any sshd
 * `TrustedUserCAKeys` directive in machine setup that has no `RevokedKeys` beside it.
 * See `docs/access.md`, "Roles from the identity provider" and "Revocation".
 */
const REPO = path.resolve(import.meta.dir, "../../../..");
const MACHINE_SETUP = ["apps/agent", "apps/tunnel-daemon", "apps/control-plane/src", "infra"];
const DIRECTIVE = /^\s*TrustedUserCAKeys\s+\S/m;

describe("SSH CA trust and revocation", () => {
  test("no machine setup trusts the CA without a revocation list", () => {
    const files = execFileSync("git", ["ls-files", "--", ...MACHINE_SETUP], { cwd: REPO })
      .toString()
      .split("\n")
      .filter((file) => file && !file.includes(".test.") && !file.includes("/ssh-ca/"));
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(path.join(REPO, file), "utf8");
      if (DIRECTIVE.test(text) && !/^\s*RevokedKeys\s+\S/m.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
