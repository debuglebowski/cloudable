/**
 * Real, narrow config-state observation: which access methods (spec §11)
 * currently have a live, running process on this machine. This is the
 * `runningAccessMethods` half of `ConfigState`
 * (`packages/contracts/src/domains/agent-protocol.ts`) — the other, cheap
 * half of "installed packages and config state" (spec §8.1) that
 * `poll-report-loop.ts` reports alongside `installedPackages`/`openPorts`.
 *
 * Deliberately narrow (not full configuration coverage): each entry in
 * `ACCESS_METHODS` names one access method and a process marker to look
 * for in every running process's command line, the same shape a future
 * desired-state setting ("is this access method enabled") can be diffed
 * against once one exists. No web terminal process is wired into this
 * build yet (`docs/agents.md`: the tunnel daemon isn't implemented here),
 * so this returns `[]` on every real machine today — an honest signal,
 * not a bug, same reasoning as `installed-packages.ts`-style "nothing
 * found" cases elsewhere in this agent.
 *
 * Reads `/proc/<pid>/cmdline` directly rather than shelling out to `ps` —
 * no subprocess, and this agent's only real deployment target is Linux
 * (`bun-linux-{x64,arm64}`, see package.json). Falls back to `[]` with a
 * logged warning on any other platform, matching `open-ports.ts`'s
 * `/proc`-unavailable fallback.
 */

interface AccessMethodMarker {
  /** The access-method identifier reported in `runningAccessMethods` — stable, not display text. */
  readonly name: string;
  /** Substring looked for in a running process's `/proc/<pid>/cmdline`. */
  readonly processMarker: string;
}

const ACCESS_METHODS: readonly AccessMethodMarker[] = [
  // `ttyd` is the plain web terminal spec §11.1 describes ("not code-server").
  // Once the tunnel daemon actually installs and runs one, this is what the
  // agent looks for; nothing in this build spawns it yet.
  { name: "web_terminal", processMarker: "ttyd" },
];

const NUL = String.fromCharCode(0);

/** Abstracts the one primitive this module needs from the OS — every
 * currently-running process's command line. Injectable so
 * `listRunningAccessMethods` can be unit-tested without a real `/proc`. */
export interface ProcessLister {
  listCommandLines(): Promise<string[]>;
}

export const procProcessLister: ProcessLister = {
  async listCommandLines() {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir("/proc");
    const pids = entries.filter((entry) => /^\d+$/.test(entry));

    const cmdlines = await Promise.all(
      pids.map(async (pid) => {
        try {
          // `/proc/<pid>/cmdline` is NUL-separated argv, not space-separated —
          // rejoin with spaces so a plain substring match against `processMarker`
          // works regardless of where the binary name lands in argv.
          const raw = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
          return raw.split(NUL).join(" ").trim();
        } catch {
          // The process exited between `readdir` and `readFile` (normal
          // churn), or `/proc/<pid>` belongs to another user and isn't
          // readable — neither is fatal to the scan as a whole.
          return "";
        }
      }),
    );
    return cmdlines.filter((line) => line.length > 0);
  },
};

/**
 * Real inventory of which known access-method processes are currently
 * running. Returns `[]` on non-Linux platforms (logged) or if the `/proc`
 * scan itself fails outright, rather than throwing — same "honest signal,
 * not a fatal error" reasoning as `open-ports.ts`.
 */
export async function listRunningAccessMethods(
  lister: ProcessLister = procProcessLister,
): Promise<string[]> {
  if (process.platform !== "linux") {
    console.warn("access-methods: /proc scan skipped — not running on Linux");
    return [];
  }

  let cmdlines: string[];
  try {
    cmdlines = await lister.listCommandLines();
  } catch (error) {
    console.warn(`access-methods: /proc scan failed: ${String(error)}`);
    return [];
  }

  return ACCESS_METHODS.filter(({ processMarker }) =>
    cmdlines.some((cmdline) => cmdline.includes(processMarker)),
  ).map(({ name }) => name);
}
