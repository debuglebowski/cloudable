import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * A tripwire, not a proof. It keeps one fact true about THIS REPOSITORY: nothing Cloudable ships
 * configures a machine to trust its SSH certificate authority. As long as that holds, a
 * certificate Cloudable issued authenticates to nothing Cloudable set up, and revoking a
 * person's control-plane credentials (and closing their tunnels) is what revokes their access.
 *
 * What it cannot see, and does not claim: machines or images configured outside this code, an
 * operator adding the CA key by hand (the CA public key is inside every certificate), or a
 * deployment whose machines subnet is not the one this repo's Terraform locks down (the Azure
 * provisioner takes any `AZURE_MACHINES_SUBNET_ID` and gives each machine a public IP). Those
 * are deployment assumptions, listed in `docs/access.md` ("SSH certificates and revocation").
 *
 * If machines are ever meant to trust the CA, this test has to change in the same commit as a
 * working revocation path (a KRL distributed to every machine and kept current from
 * `certificates.revoked_at`), with tests of that path. It has no escape hatch on purpose.
 */
const REPO = path.resolve(import.meta.dir, "../../../..");

/** Everywhere machine setup could come from: the agent, the tunnel daemon, provisioning, the
 * hardening baseline, cloud-init, Docker images, Terraform, scripts. */
const SCOPE = [
  "apps/agent",
  "apps/tunnel-daemon",
  "apps/control-plane/src",
  "apps/control-plane/Dockerfile",
  "infra",
  "scripts",
  "docker",
  "docker-compose.yml",
];

/** Every way sshd (or authorized_keys) can be told to accept a user CA. Matched anywhere in a
 * file, in any form: a config line, an `echo` in a shell script, a string in TypeScript, JSON,
 * cloud-init YAML. Case-insensitive. */
const TRUST_MARKERS = [
  /TrustedUserCAKeys/i,
  /cert-authority/i,
  /AuthorizedPrincipals(File|Command)/i,
];

/** Mentions that are documentation of the rule itself, by exact file and line text. */
const KNOWN_MENTIONS: ReadonlyArray<{ file: string; line: string }> = [
  {
    file: "apps/control-plane/src/services/hardening.ts",
    line: "# ships its own file in this directory. TrustedUserCAKeys is not touched here.",
  },
];

/** The SSH CA itself, its tests, and this guard. */
const EXCLUDED = (file: string) =>
  file.includes("/ssh-ca/") || file.includes(".test.") || file.endsWith(".md");

const inventory = (): string[] => {
  const scope = SCOPE.filter((entry) => existsSync(path.join(REPO, entry)));
  const list = (args: string[]) =>
    execFileSync("git", args, { cwd: REPO }).toString().split("\n").filter(Boolean);
  // Tracked and untracked (not ignored) files: a new provisioning script is covered before it
  // is committed.
  return [
    ...new Set([
      ...list(["ls-files", "--", ...scope]),
      ...list(["ls-files", "--others", "--exclude-standard", "--", ...scope]),
    ]),
  ];
};

describe("SSH CA trust (repository tripwire)", () => {
  const files = inventory();

  test("covers the files that set up machines", () => {
    expect(files.length).toBeGreaterThan(200);
    for (const required of [
      "apps/control-plane/src/services/hardening.ts",
      "apps/control-plane/src/services/ProvisioningService.azure.ts",
      "apps/control-plane/src/services/ProvisioningService.docker.ts",
      "apps/tunnel-daemon/src/session-manager.ts",
      "infra/terraform/control-plane/main.tf",
    ]) {
      expect(files).toContain(required);
    }
  });

  test("nothing in it tells a machine to trust a user CA", () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => !EXCLUDED(f))) {
      const full = path.join(REPO, file);
      if (!existsSync(full)) continue;
      const lines = readFileSync(full, "utf8").split("\n");
      lines.forEach((text, index) => {
        if (!TRUST_MARKERS.some((marker) => marker.test(text))) return;
        const known = KNOWN_MENTIONS.some((m) => m.file === file && text.trim() === m.line);
        if (!known) offenders.push(`${file}:${index + 1}: ${text.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the known mentions still exist, so the allowlist cannot silently hide new text", () => {
    for (const mention of KNOWN_MENTIONS) {
      const lines = readFileSync(path.join(REPO, mention.file), "utf8").split("\n");
      expect(lines.map((l) => l.trim())).toContain(mention.line);
    }
  });

  test("catches the forms it claims to", () => {
    for (const sample of [
      "TrustedUserCAKeys /etc/ssh/ca.pub",
      'echo "TrustedUserCAKeys /etc/ssh/ca.pub" >> /etc/ssh/sshd_config',
      '{"content":"trustedusercakeys /etc/ssh/ca.pub"}',
      "cert-authority ssh-ed25519 AAAA...",
      "AuthorizedPrincipalsFile /etc/ssh/principals/%u",
    ]) {
      expect(TRUST_MARKERS.some((marker) => marker.test(sample))).toBe(true);
    }
  });
});
