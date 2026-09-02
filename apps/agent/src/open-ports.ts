/**
 * Real inventory of listening TCP ports — the other half of "installed
 * packages and config state" `poll-report-loop.ts` reports.
 * Before this, `openPorts` was always `[]`, with no scan behind it at all.
 *
 * Reads `/proc/net/tcp`/`/proc/net/tcp6` directly rather than shelling out
 * to `ss`/`netstat` — no subprocess to spawn, and this agent's only real
 * deployment target is Linux (`bun-linux-{x64,arm64}`, see package.json's
 * `build`/`build:arm64`). A developer running `bun run dev` on macOS or
 * Windows has no `/proc` at all; that falls back to `[]` with a logged
 * warning rather than throwing — same "honest signal, not a fatal error"
 * reasoning the rest of this agent's observed-state gathering uses: a
 * report with no observed ports is truthful, and crashing the poll/report
 * loop's backoff (`backoff.ts`) over a platform mismatch it can never fix
 * would not be.
 */

const PROC_TCP_FILES = ["/proc/net/tcp", "/proc/net/tcp6"] as const;

// The `st` column of `/proc/net/tcp{,6}`, hex-encoded kernel socket state.
// Only listening sockets count as an "open port" here — an established
// outbound connection (e.g. this agent's own poll/report `fetch` calls)
// isn't one.
const TCP_LISTEN = "0A";

/** Abstracts the one primitive this module needs from the OS — read a file's
 * contents as text, or throw. Injectable so `listOpenPorts` can be unit-tested
 * with fake `/proc` contents instead of a real Linux kernel's `/proc/net/tcp`. */
export interface ProcFileReader {
  read(path: string): Promise<string>;
}

/**
 * `node:fs/promises.readFile`, not `Bun.file(path).text()` — procfs files
 * report a zero `st_size` from `stat()` (their content is generated on
 * read, not stored), and `Bun.file` sizes its read buffer from `stat()`
 * first; `fs.readFile` reads in a loop until EOF instead of trusting that
 * size, which is what a pseudo-file like `/proc/net/tcp` needs.
 */
export const procFileReader: ProcFileReader = {
  async read(path) {
    const { readFile } = await import("node:fs/promises");
    return readFile(path, "utf8");
  },
};

/** One data line (not the header) of `/proc/net/tcp{,6}` into a listening port,
 * or `null` if it isn't a `TCP_LISTEN` socket or the line is malformed. */
function parseListeningPort(line: string): number | null {
  const fields = line.trim().split(/\s+/);
  const localAddress = fields[1];
  const state = fields[3];
  if (!localAddress || state !== TCP_LISTEN) return null;

  const hexPort = localAddress.split(":")[1];
  if (!hexPort) return null;
  const port = Number.parseInt(hexPort, 16);
  return Number.isInteger(port) ? port : null;
}

/**
 * Real, deduped, sorted inventory of listening TCP ports (v4 and v6).
 * Returns `[]` on non-Linux platforms (logged) rather than throwing.
 * A missing/unreadable individual proc file (e.g. `/proc/net/tcp6` when
 * IPv6 is disabled) is skipped, not fatal — same reasoning as the
 * platform-wide fallback, just scoped to one file instead of the whole scan.
 */
export async function listOpenPorts(reader: ProcFileReader = procFileReader): Promise<number[]> {
  if (process.platform !== "linux") {
    console.warn("open-ports: /proc/net/tcp scan skipped — not running on Linux");
    return [];
  }

  const ports = new Set<number>();
  for (const path of PROC_TCP_FILES) {
    let contents: string;
    try {
      contents = await reader.read(path);
    } catch (error) {
      console.warn(`open-ports: failed to read ${path}: ${String(error)}`);
      continue;
    }
    // First line is the column header (`sl local_address rem_address st ...`), not data.
    for (const line of contents.split("\n").slice(1)) {
      const port = parseListeningPort(line);
      if (port !== null) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}
