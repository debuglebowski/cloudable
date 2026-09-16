import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Reads the checked-in ext4 image built by `__fixtures__/build-fixture.sh` — a real
// filesystem made by the same `mkfs.ext4` invocation a real machine's persistent disk
// gets, not a hand-built buffer. The expectations below come from `debugfs` output
// captured at build time (`__fixtures__/expected-root.txt`), so this asserts the reader
// against the filesystem rather than against itself.
import { gunzipSync } from "node:zlib";
import { FS_MAX_ENTRIES } from "@cloudable/contracts";
import { cachingReader, fileRangeReader } from "../range-reader";
import { type SnapshotFilesystem, openExt4Filesystem } from "./filesystem";

const FIXTURE = new URL("../__fixtures__/home.img.gz", import.meta.url).pathname;
const ROOT = "/home/cloudable";

let fs: SnapshotFilesystem;
let reads = 0;

beforeAll(async () => {
  const image = join(mkdtempSync(join(tmpdir(), "cloudable-ext4-")), "home.img");
  writeFileSync(image, gunzipSync(readFileSync(FIXTURE)));

  const file = await fileRangeReader(image);
  // Counting round trips through the UNCACHED reader: in production each one is an
  // HTTPS request to blob storage, so "does the cache actually spare them" is a
  // property worth asserting, not just hoping for.
  const counted = {
    size: () => file.size(),
    read: (offset: number, length: number) => {
      reads++;
      return file.read(offset, length);
    },
  };
  fs = await openExt4Filesystem(cachingReader(counted));
});

describe("listing", () => {
  test("reads the root of the persistent disk", async () => {
    const result = await fs.list(ROOT);
    if (!result.ok || result.op !== "list")
      throw new Error(`unexpected: ${JSON.stringify(result)}`);

    expect(result.path).toBe(ROOT);
    expect(result.parent).toBe("/home");
    expect(result.truncated).toBe(false);
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "big.bin",
      "empty-dir",
      "empty.txt",
      "exactly-1mib.txt",
      "link-long",
      "link-to-notes",
      "logo.png",
      "many",
      "notes.txt",
      "private.txt",
      "projects",
    ]);
  });

  test("reports type, size and mode as debugfs saw them", async () => {
    const result = await fs.list(ROOT);
    if (!result.ok || result.op !== "list") throw new Error("expected a listing");
    const byName = new Map(result.entries.map((entry) => [entry.name, entry]));

    expect(byName.get("big.bin")).toMatchObject({
      type: "file",
      sizeBytes: 2097152,
      mode: "rw-r--r--",
    });
    expect(byName.get("projects")).toMatchObject({ type: "directory" });
    expect(byName.get("empty.txt")).toMatchObject({ type: "file", sizeBytes: 0 });
    // 100600 in the debugfs capture. Reported, and NOT enforced — there is no uid here
    // to enforce it against, which is the whole reason the access gate carries the weight.
    expect(byName.get("private.txt")?.mode).toBe("rw-------");
  });

  test("shows a symlink as itself, with its target", async () => {
    const result = await fs.list(ROOT);
    if (!result.ok || result.op !== "list") throw new Error("expected a listing");
    const byName = new Map(result.entries.map((entry) => [entry.name, entry]));

    // Short target: stored inside the inode, no data block allocated.
    expect(byName.get("link-to-notes")).toMatchObject({
      type: "symlink",
      symlinkTarget: "notes.txt",
    });
    // 103 bytes, too long for the inode, so it lives in a block — a different read path.
    expect(byName.get("link-long")?.symlinkTarget).toContain("treasure.txt");
  });

  test("descends into nested directories", async () => {
    const result = await fs.list(`${ROOT}/projects/deep/nested`);
    if (!result.ok || result.op !== "list") throw new Error("expected a listing");
    expect(result.entries.map((entry) => entry.name)).toEqual(["treasure.txt"]);
  });

  test("an empty directory lists as empty, not as missing", async () => {
    const result = await fs.list(`${ROOT}/empty-dir`);
    if (!result.ok || result.op !== "list") throw new Error("expected a listing");
    expect(result.entries).toEqual([]);
  });

  test("truncates a directory past the entry cap instead of returning all of it", async () => {
    const result = await fs.list(`${ROOT}/many`);
    if (!result.ok || result.op !== "list") throw new Error("expected a listing");

    // 12,000 files on disk, and the hash index those need is exactly the structure a
    // linear dirent walk has to step over rather than parse.
    expect(result.entries).toHaveLength(FS_MAX_ENTRIES);
    expect(result.truncated).toBe(true);
  });

  test("honours a caller's smaller limit", async () => {
    const result = await fs.list(`${ROOT}/many`, 5);
    if (!result.ok || result.op !== "list") throw new Error("expected a listing");
    expect(result.entries).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });
});

describe("reading", () => {
  test("reads a small text file", async () => {
    const result = await fs.read(`${ROOT}/notes.txt`);
    if (!result.ok || result.op !== "read")
      throw new Error(`unexpected: ${JSON.stringify(result)}`);
    expect(Buffer.from(result.contentBase64, "base64").toString()).toBe(
      "the file someone needs back after they leave\n",
    );
  });

  test("follows a symlink when reading through it", async () => {
    const result = await fs.read(`${ROOT}/link-to-notes`);
    if (!result.ok || result.op !== "read") throw new Error("expected a read");
    expect(Buffer.from(result.contentBase64, "base64").toString()).toContain("someone needs back");
  });

  test("reads a file at exactly the inline ceiling", async () => {
    const result = await fs.read(`${ROOT}/exactly-1mib.txt`);
    if (!result.ok || result.op !== "read") throw new Error("expected a read");
    const bytes = Buffer.from(result.contentBase64, "base64");
    expect(bytes.byteLength).toBe(1024 * 1024);
    expect(bytes.every((byte) => byte === 0x61)).toBe(true);
  });

  test("refuses a file over the inline ceiling", async () => {
    expect(await fs.read(`${ROOT}/big.bin`)).toEqual({ ok: false, reason: "too_large" });
  });

  test("refuses a file with a NUL byte", async () => {
    expect(await fs.read(`${ROOT}/logo.png`)).toEqual({ ok: false, reason: "is_binary" });
  });

  test("refuses to read a directory as a file", async () => {
    expect(await fs.read(`${ROOT}/projects`)).toEqual({ ok: false, reason: "is_a_directory" });
  });

  test("an empty file reads as empty", async () => {
    const result = await fs.read(`${ROOT}/empty.txt`);
    if (!result.ok || result.op !== "read") throw new Error("expected a read");
    expect(result.contentBase64).toBe("");
  });
});

describe("downloading", () => {
  test("returns every byte of a multi-megabyte file", async () => {
    const { result, bytes } = await fs.download(`${ROOT}/big.bin`);
    if (!result.ok || result.op !== "download") throw new Error("expected a download");

    expect(result.sizeBytes).toBe(2097152);
    expect(bytes?.byteLength).toBe(2097152);
    // Every byte, not just the ends: a reader that lost a block in the middle of an
    // extent would still get the first and last right.
    expect(bytes?.every((byte) => byte === 0x7a)).toBe(true);
  });

  test("a binary file is downloadable even though it cannot be read inline", async () => {
    const { result, bytes } = await fs.download(`${ROOT}/logo.png`);
    if (!result.ok) throw new Error("expected a download");
    expect(Buffer.from(bytes ?? new Uint8Array()).toString("binary")).toContain("binary payload");
  });
});

describe("paths", () => {
  test("rejects a relative path", async () => {
    expect(await fs.list("cloudable")).toEqual({ ok: false, reason: "invalid_path" });
  });

  test("rejects a path containing NUL", async () => {
    expect(await fs.read(`${ROOT}/notes.txt\0.png`)).toEqual({ ok: false, reason: "invalid_path" });
  });

  test("normalises traversal rather than trusting it", async () => {
    const result = await fs.list(`${ROOT}/projects/../projects/deep/..`);
    if (!result.ok || result.op !== "list") throw new Error("expected a listing");
    expect(result.path).toBe(`${ROOT}/projects`);
  });

  test("a path off this disk is not found, not a crash", async () => {
    // /etc is on the OS disk, which this snapshot does not contain.
    expect(await fs.read("/etc/nginx/nginx.conf")).toEqual({ ok: false, reason: "not_found" });
  });

  test("a missing file is not_found", async () => {
    expect(await fs.read(`${ROOT}/nope.txt`)).toEqual({ ok: false, reason: "not_found" });
  });

  test("descending through a file is not_a_directory", async () => {
    expect(await fs.list(`${ROOT}/notes.txt/x`)).toEqual({ ok: false, reason: "not_a_directory" });
  });

  test("lists the mount point itself", async () => {
    const result = await fs.list("/home");
    if (!result.ok || result.op !== "list") throw new Error("expected a listing");
    expect(result.parent).toBeNull();
    // `lost+found` is on every ext4 filesystem and is shown rather than filtered:
    // this browser reports what is on the disk, and hiding a directory because it is
    // usually empty is the start of deciding what an investigator may see.
    expect(result.entries.map((entry) => entry.name)).toEqual(["cloudable", "lost+found"]);
  });
});

describe("read volume", () => {
  test("re-listing a directory costs no further reads", async () => {
    await fs.list(`${ROOT}/projects`);
    const before = reads;
    await fs.list(`${ROOT}/projects`);
    // Every read here would be an HTTPS round trip against a real snapshot. The cache
    // is what keeps one directory from costing dozens of them.
    expect(reads).toBe(before);
  });
});
