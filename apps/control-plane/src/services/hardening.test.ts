import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARDENING_BASELINE_PATTERN } from "@cloudable/contracts";
import {
  HARDENING_BASELINE,
  HARDENING_EXCEPTIONS,
  HARDENING_SCRIPT_PATH,
  HARDENING_STAMP_PATH,
  hardeningSection,
} from "./hardening";

/** The baseline script itself, lifted out of the cloud-init heredoc that carries it. */
function extractScript(): string {
  const section = hardeningSection();
  const start = section.indexOf("<<'CLOUDABLE_HARDEN_EOF'\n");
  const end = section.lastIndexOf("\nCLOUDABLE_HARDEN_EOF");
  if (start < 0 || end < 0) throw new Error("baseline heredoc not found");
  return section.slice(start + "<<'CLOUDABLE_HARDEN_EOF'\n".length, end + 1);
}

/** The script with comment lines removed: the explanations name the things it must not do. */
const executable = () =>
  extractScript()
    .split("\n")
    .filter((line) => !line.trim().startsWith("#") || line.startsWith("#!"))
    .join("\n");

describe("hardeningSection", () => {
  test("is valid bash, both the fragment and the script it carries", () => {
    for (const source of [`set -e\n${hardeningSection()}`, extractScript()]) {
      const result = Bun.spawnSync(["bash", "-n"], { stdin: new TextEncoder().encode(source) });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    }
  });

  test("runs the script in its own process and carries on when it fails", () => {
    const section = hardeningSection();
    // `if !` is what keeps a failed baseline from stopping the agent installing, and the
    // separate process is what keeps `set -e` live inside the script.
    expect(section).toContain(`if ! ${HARDENING_SCRIPT_PATH}; then`);
    expect(section).toContain("continuing without it");
    expect(extractScript().startsWith("#!/bin/bash\n")).toBe(true);
    expect(extractScript()).toContain("set -euo pipefail");
  });

  test("writes the stamp only after the read-back checks, and atomically", () => {
    const script = extractScript();
    const lastCheck = script.lastIndexOf("expect ");
    const stampWrite = script.indexOf('> "$STAMP.tmp"');
    expect(lastCheck).toBeGreaterThan(0);
    expect(stampWrite).toBeGreaterThan(lastCheck);
    expect(script).toContain('mv "$STAMP.tmp" "$STAMP"');
    expect(script).toContain(`STAMP=${HARDENING_STAMP_PATH}`);
  });

  test("the stamp names the baseline and every documented exception", () => {
    const script = extractScript();
    expect(script).toContain(`BASELINE=${HARDENING_BASELINE}`);
    expect(script).toContain(JSON.stringify(HARDENING_EXCEPTIONS.map((e) => e.id)));
    expect(HARDENING_BASELINE).toMatch(HARDENING_BASELINE_PATTERN);
  });

  test("does not undo any listed exception", () => {
    const script = executable();
    // Each of these would break a developer tool the exceptions exist to protect.
    expect(script).not.toContain("ip_forward");
    expect(script).not.toMatch(/install (udf|squashfs) /);
    expect(script).not.toContain("noexec");
    expect(script).not.toContain("cron.allow");
    expect(script).not.toContain("NOPASSWD");
    expect(script).not.toMatch(/chage|PASS_MAX_DAYS|pwquality/);
  });

  test("never installs or removes a package (invariant 4)", () => {
    const script = executable();
    expect(script).not.toMatch(/apt(-get)?\s+(install|remove|purge)/);
    expect(script).not.toContain("dpkg ");
  });

  test("leaves the sshd certificate trust alone", () => {
    expect(executable()).not.toContain("TrustedUserCAKeys");
  });

  test("reads a disabled module back from modprobe's real output", () => {
    const check = executable()
      .split("\n")
      .find((line) => line.includes('expect "module $m"'));
    if (!check) throw new Error("module check not found");
    const run = (modprobeOutput: string) =>
      Bun.spawnSync([
        "bash",
        "-c",
        `modprobe() { printf '${modprobeOutput}'; }
fail() { echo "FAIL $1"; exit 1; }
expect() { [ "$2" = "$3" ] || fail "$1 is '$2'"; }
m=cramfs
${check}
echo ok`,
      ]).stdout.toString();
    // Ubuntu 24.04 on Azure, verbatim: a dependency first, and a trailing space on every line.
    const kernelModule = "/lib/modules/7.0.0-1017-azure/kernel/drivers/mtd/mtd.ko.zst";
    expect(run(`insmod ${kernelModule} \\ninstall /bin/false \\n`)).toBe("ok\n");
    expect(run("install /bin/false \\n")).toBe("ok\n");
    // Not disabled: only insmod lines, so the check must still fail.
    expect(run(`insmod ${kernelModule} \\n`)).toStartWith("FAIL");
  });

  test("creates sshd's privilege separation directory before testing the config", () => {
    // Without it `sshd -t` fails on a socket-activated first boot and the baseline is dropped.
    const script = executable();
    const mkdir = script.indexOf("install -d -m 0755 /run/sshd");
    expect(mkdir).toBeGreaterThan(-1);
    expect(mkdir).toBeLessThan(script.indexOf("sshd -t"));
  });

  test("does not use a JS template interpolation by accident inside the bash", () => {
    // A stray `${` in the source would have been consumed by TypeScript.
    expect(extractScript()).not.toContain("undefined");
    expect(extractScript()).not.toContain("[object");
  });
});

describe("HARDENING_EXCEPTIONS", () => {
  test("has unique, stable, fully described entries", () => {
    const ids = HARDENING_EXCEPTIONS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of HARDENING_EXCEPTIONS) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.control.length).toBeGreaterThan(0);
      expect(e.deviation.length).toBeGreaterThan(0);
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });

  test("is exactly what docs/hardening.md lists, so the two cannot drift", () => {
    const doc = readFileSync(join(import.meta.dir, "../../../../docs/hardening.md"), "utf-8");
    for (const e of HARDENING_EXCEPTIONS) {
      expect(doc).toContain(`\`${e.id}\``);
    }
    expect(doc).toContain(`\`${HARDENING_BASELINE}\``);
    expect(doc).toContain(HARDENING_STAMP_PATH);
  });
});
