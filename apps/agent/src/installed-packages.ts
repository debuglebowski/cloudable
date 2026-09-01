/**
 * Real inventory of installed OS packages — the observed half of drift
 * detection (spec §7 "allowlist": anything installed outside the manifest is
 * detected on reconcile and surfaced; §12: "the agent never submits audit
 * events... it reports observed state"). Before this, `installedPackages` was
 * always `[]` (see `poll-report-loop.ts`'s old comment) — the control
 * plane's own diffing (`computeUndeclaredPackages`, `runDiffAndPublish`) was
 * real from iteration 4 onward but had nothing to compare against.
 *
 * Every build target for this agent is `bun-linux-{x64,arm64}` (see
 * package.json) — no macOS/Windows path needed. Detects whichever package
 * manager is actually present rather than assuming one distro family:
 * `dpkg-query` (Debian/Ubuntu) is tried first, then `rpm` (RHEL/Fedora/Amazon
 * Linux). Neither present returns `[]` rather than throwing — a report with
 * no observed packages is an honest signal (nothing reads as undeclared
 * that wouldn't otherwise), not a fatal error that should trip the
 * poll/report loop's backoff (`backoff.ts`) over something orthogonal to
 * attestation.
 */

interface PackageManager {
  readonly binary: string;
  readonly args: readonly string[];
  readonly parse: (stdout: string) => string[];
}

// Bare package name per line, no version — matches `computeUndeclaredPackages`'s
// comparison against `ResolvedManifestEntry.packageName` (pinning is a manifest-side
// concern, docs/inheritance.md §6, not an observed-state one).
const DPKG: PackageManager = {
  binary: "dpkg-query",
  args: ["-W", "-f=${Package}\\n"],
  parse: linesOf,
};

const RPM: PackageManager = {
  binary: "rpm",
  args: ["-qa", "--qf", "%{NAME}\\n"],
  parse: linesOf,
};

const PACKAGE_MANAGERS: readonly PackageManager[] = [DPKG, RPM];

function linesOf(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface CommandResult {
  readonly stdout: string;
  readonly exitCode: number;
}

/** Abstracts the one primitive this module needs from the OS — runs a command,
 * returns its stdout and exit code, or `null` when the binary itself can't be
 * found/spawned. Injectable so `listInstalledPackages` can be unit-tested without
 * a real dpkg/rpm system present (this repo's own dev/CI machines have neither). */
export interface CommandRunner {
  run(binary: string, args: readonly string[]): Promise<CommandResult | null>;
}

export const bunCommandRunner: CommandRunner = {
  async run(binary, args) {
    try {
      const proc = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { stdout, exitCode };
    } catch {
      // ENOENT (binary not on PATH) or any other spawn-level failure — treated the
      // same as "this package manager isn't present," not a report-blocking error.
      return null;
    }
  },
};

/** Tries each known package manager in order, returns the first whose binary is
 * present and exits cleanly. `runner` defaults to actually shelling out
 * (`bunCommandRunner`); tests inject a fake one instead. */
export async function listInstalledPackages(
  runner: CommandRunner = bunCommandRunner,
): Promise<string[]> {
  for (const pm of PACKAGE_MANAGERS) {
    const result = await runner.run(pm.binary, pm.args);
    if (result === null || result.exitCode !== 0) continue;
    return [...new Set(pm.parse(result.stdout))];
  }
  return [];
}
