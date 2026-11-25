import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPgpFingerprint } from "./openpgp-fingerprint";

// NodeSource's published repository key, fetched 2026-11-25 from
// https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key. `gpg --show-keys` names its
// primary key 6F71F525282841EEDAF851B42F59B5F99B1BE0B4.
const NODESOURCE = readFileSync(join(import.meta.dir, "__fixtures__/nodesource-repo.asc"), "utf8");

describe("openPgpFingerprint", () => {
  test("matches gpg's fingerprint for a real v4 key", () => {
    expect(openPgpFingerprint(NODESOURCE)).toBe("6F71F525282841EEDAF851B42F59B5F99B1BE0B4");
  });

  test("refuses what is not one armored public key block", () => {
    expect(openPgpFingerprint("")).toBeNull();
    expect(openPgpFingerprint("not a key")).toBeNull();
    expect(openPgpFingerprint(NODESOURCE.replace("PUBLIC KEY", "PRIVATE KEY"))).toBeNull();
    expect(openPgpFingerprint(`${NODESOURCE}\n${NODESOURCE}`)).toBeNull();
    expect(
      openPgpFingerprint(
        "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nAAAA\n-----END PGP PUBLIC KEY BLOCK-----",
      ),
    ).toBeNull();
  });
});
