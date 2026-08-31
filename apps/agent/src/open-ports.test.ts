import { describe, expect, test } from "bun:test";
import type { ProcFileReader } from "./open-ports";
import { listOpenPorts } from "./open-ports";

/** A fake `ProcFileReader` keyed by path — a missing entry rejects, mirroring
 * `node:fs/promises.readFile` throwing ENOENT for a proc file that doesn't exist
 * (e.g. `/proc/net/tcp6` with IPv6 disabled). */
function fakeReader(files: Record<string, string>): ProcFileReader {
  return {
    read: async (path) => {
      const contents = files[path];
      if (contents === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return contents;
    },
  };
}

// Real `/proc/net/tcp` header + two rows: one `LISTEN` (0A) on port 22 (0016),
// one `ESTABLISHED` (01) on port 443 (01BB) — only the listening one counts.
const TCP_WITH_ONE_LISTENER = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:01BB 0100007F:C35C 01 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 20 4 30 10 -1`;

const originalPlatform = process.platform;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("listOpenPorts", () => {
  test("parses only LISTEN-state sockets into ports, from /proc/net/tcp", async () => {
    setPlatform("linux");
    try {
      const reader = fakeReader({ "/proc/net/tcp": TCP_WITH_ONE_LISTENER, "/proc/net/tcp6": "" });
      expect(await listOpenPorts(reader)).toEqual([22]);
    } finally {
      setPlatform(originalPlatform);
    }
  });

  test("merges and dedupes ports across tcp and tcp6, sorted ascending", async () => {
    setPlatform("linux");
    try {
      const tcp6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0`;
      const reader = fakeReader({ "/proc/net/tcp": TCP_WITH_ONE_LISTENER, "/proc/net/tcp6": tcp6 });
      expect(await listOpenPorts(reader)).toEqual([22, 80]);
    } finally {
      setPlatform(originalPlatform);
    }
  });

  test("skips a proc file that fails to read (e.g. IPv6 disabled) instead of throwing", async () => {
    setPlatform("linux");
    try {
      const reader = fakeReader({ "/proc/net/tcp": TCP_WITH_ONE_LISTENER });
      expect(await listOpenPorts(reader)).toEqual([22]);
    } finally {
      setPlatform(originalPlatform);
    }
  });

  test("returns [] when nothing is listening", async () => {
    setPlatform("linux");
    try {
      const header =
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
      const reader = fakeReader({ "/proc/net/tcp": header, "/proc/net/tcp6": header });
      expect(await listOpenPorts(reader)).toEqual([]);
    } finally {
      setPlatform(originalPlatform);
    }
  });

  test("returns [] and never calls the reader on a non-Linux platform", async () => {
    setPlatform("darwin");
    try {
      let called = false;
      const reader: ProcFileReader = {
        read: async () => {
          called = true;
          return "";
        },
      };
      expect(await listOpenPorts(reader)).toEqual([]);
      expect(called).toBe(false);
    } finally {
      setPlatform(originalPlatform);
    }
  });
});
