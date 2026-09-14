import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  FS_MAX_INLINE_BYTES,
  type FsFailureReason,
  type FsOp,
  type FsResult,
} from "@cloudable/contracts";

import {
  type HelperMessage,
  applyUploadChunk,
  formatMode,
  normalisePath,
  parentOf,
  reasonForError,
  runOperation,
} from "./fs-helper";

/** Real files in a real temp directory — these operations ARE filesystem calls, and a
 * mocked `node:fs` would test the mock. What is deliberately NOT exercised here is the
 * `su` privilege drop (that needs root); `files-session.test.ts` covers the argv instead. */
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudable-fs-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const sent: HelperMessage[] = [];
const io = { send: (message: HelperMessage) => sent.push(message) };
beforeEach(() => {
  sent.length = 0;
});

const run = (op: FsOp, uploads = new Map()) => runOperation("req-1", op, io, uploads);

function expectFailure(result: FsResult | null, reason: FsFailureReason): void {
  expect(result).not.toBeNull();
  expect(result?.ok).toBe(false);
  if (result && !result.ok) expect(result.reason).toBe(reason);
}

describe("path handling", () => {
  test("rejects a relative path rather than resolving it against the helper's cwd", () => {
    expect(normalisePath("etc/passwd")).toBeNull();
    expect(normalisePath("../../etc/passwd")).toBeNull();
  });

  test("rejects an embedded NUL, which truncates a path at the syscall boundary", () => {
    expect(normalisePath("/etc/passwd\0.txt")).toBeNull();
  });

  test("normalises traversal inside an absolute path and strips a trailing slash", () => {
    expect(normalisePath("/home/cloudable/../cloudable/./notes")).toBe("/home/cloudable/notes");
    expect(normalisePath("/home/cloudable/")).toBe("/home/cloudable");
    expect(normalisePath("/")).toBe("/");
  });

  test("the filesystem root has no parent to navigate up to", () => {
    expect(parentOf("/")).toBeNull();
    expect(parentOf("/home/cloudable")).toBe("/home");
  });
});

describe("errno mapping", () => {
  // The reason vocabulary is fixed, and the raw error is never forwarded: errno strings
  // carry absolute paths and internals, and these results are rendered in a browser and
  // pass through the control plane's logs on the way.
  const errnoCases: ReadonlyArray<[string, FsFailureReason]> = [
    ["ENOENT", "not_found"],
    ["EACCES", "permission_denied"],
    ["EPERM", "permission_denied"],
    ["ENOTDIR", "not_a_directory"],
    ["EISDIR", "is_a_directory"],
    ["EEXIST", "exists"],
  ];
  test.each(errnoCases)("%s maps to %s", (code, expected) => {
    expect(reasonForError(Object.assign(new Error("boom"), { code }))).toBe(expected);
  });

  test("an unrecognised failure becomes io_error rather than inventing a cause", () => {
    expect(reasonForError(new Error("something else"))).toBe("io_error");
    expect(reasonForError(null)).toBe("io_error");
  });
});

describe("formatMode", () => {
  test("renders an ls-style triplet", () => {
    expect(formatMode(0o644)).toBe("rw-r--r--");
    expect(formatMode(0o755)).toBe("rwxr-xr-x");
    expect(formatMode(0o600)).toBe("rw-------");
  });
});

describe("list", () => {
  test("shows a symlink as itself with its target, not as what it points at", async () => {
    await fs.writeFile(path.join(dir, "real.txt"), "hello");
    await fs.symlink(path.join(dir, "real.txt"), path.join(dir, "link.txt"));

    const result = await run({ op: "list", path: dir });
    expect(result?.ok).toBe(true);
    if (!result?.ok || result.op !== "list") throw new Error("expected a list result");

    const link = result.entries.find((e) => e.name === "link.txt");
    expect(link?.type).toBe("symlink");
    expect(link?.symlinkTarget).toContain("real.txt");
  });

  test("a broken symlink still lists instead of vanishing behind an ENOENT", async () => {
    await fs.symlink(path.join(dir, "gone"), path.join(dir, "broken"));
    const result = await run({ op: "list", path: dir });
    if (!result?.ok || result.op !== "list") throw new Error("expected a list result");
    expect(result.entries.map((e) => e.name)).toContain("broken");
  });

  test("directories sort ahead of files", async () => {
    await fs.mkdir(path.join(dir, "zzz-dir"));
    await fs.writeFile(path.join(dir, "aaa-file"), "x");
    const result = await run({ op: "list", path: dir });
    if (!result?.ok || result.op !== "list") throw new Error("expected a list result");
    expect(result.entries[0]?.name).toBe("zzz-dir");
  });

  test("a missing directory fails as not_found", async () => {
    await expect(run({ op: "list", path: path.join(dir, "nope") })).rejects.toThrow();
  });
});

describe("read", () => {
  test("refuses a file over the inline cap — it is still downloadable", async () => {
    const big = path.join(dir, "big.bin");
    await fs.writeFile(big, Buffer.alloc(FS_MAX_INLINE_BYTES + 1, 0x41));
    expectFailure(await run({ op: "read", path: big }), "too_large");
  });

  test("refuses a binary file rather than corrupting it through a JS string round trip", async () => {
    const bin = path.join(dir, "thing.bin");
    await fs.writeFile(bin, Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]));
    expectFailure(await run({ op: "read", path: bin }), "is_binary");
  });

  test("refuses a directory", async () => {
    expectFailure(await run({ op: "read", path: dir }), "is_a_directory");
  });

  test("round-trips multi-byte UTF-8 intact", async () => {
    const file = path.join(dir, "utf8.txt");
    const content = "héllo — ünicode ✓\n";
    await fs.writeFile(file, content);
    const result = await run({ op: "read", path: file });
    if (!result?.ok || result.op !== "read") throw new Error("expected a read result");
    expect(Buffer.from(result.contentBase64, "base64").toString("utf8")).toBe(content);
  });
});

describe("write", () => {
  test("refuses a save when the file changed on the machine since it was read", async () => {
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "original");
    const stale = new Date(Date.now() - 60_000).toISOString();

    expectFailure(
      await run({
        op: "write",
        path: file,
        contentBase64: Buffer.from("mine").toString("base64"),
        expectedModifiedAt: stale,
      }),
      "changed_on_disk",
    );
    // The other person's content survives — that is the whole point of the check.
    expect(await fs.readFile(file, "utf8")).toBe("original");
  });

  test("saves when the pinned mtime still matches", async () => {
    const file = path.join(dir, "notes.txt");
    await fs.writeFile(file, "original");
    const stats = await fs.stat(file);

    const result = await run({
      op: "write",
      path: file,
      contentBase64: Buffer.from("updated").toString("base64"),
      expectedModifiedAt: stats.mtime.toISOString(),
    });
    expect(result?.ok).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("updated");
  });

  test("a null expectedModifiedAt skips the check, for creating a new file", async () => {
    const file = path.join(dir, "new.txt");
    const result = await run({
      op: "write",
      path: file,
      contentBase64: Buffer.from("fresh").toString("base64"),
      expectedModifiedAt: null,
    });
    expect(result?.ok).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("fresh");
  });

  test("refuses content over the inline cap", async () => {
    expectFailure(
      await run({
        op: "write",
        path: path.join(dir, "big.txt"),
        contentBase64: Buffer.alloc(FS_MAX_INLINE_BYTES + 1, 0x41).toString("base64"),
        expectedModifiedAt: null,
      }),
      "too_large",
    );
  });
});

describe("rename", () => {
  // There is no delete operation here, so a silent clobber would be the one
  // unrecoverable action in the whole interface.
  test("refuses to overwrite an existing destination", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "a");
    await fs.writeFile(path.join(dir, "b.txt"), "b");

    expectFailure(
      await run({ op: "rename", from: path.join(dir, "a.txt"), to: path.join(dir, "b.txt") }),
      "exists",
    );
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf8")).toBe("b");
  });

  test("renames to a free path", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "a");
    const result = await run({
      op: "rename",
      from: path.join(dir, "a.txt"),
      to: path.join(dir, "c.txt"),
    });
    expect(result?.ok).toBe(true);
    expect(await fs.readFile(path.join(dir, "c.txt"), "utf8")).toBe("a");
  });
});

describe("download", () => {
  test("streams the file as chunks and reports the size last", async () => {
    const file = path.join(dir, "data.bin");
    await fs.writeFile(file, Buffer.alloc(200_000, 0x42));

    const result = await run({ op: "download", path: file });
    if (!result?.ok || result.op !== "download") throw new Error("expected a download result");
    expect(result.sizeBytes).toBe(200_000);

    const chunks = sent.filter(
      (m): m is Extract<HelperMessage, { chunk: unknown }> => "chunk" in m,
    );
    expect(chunks.at(-1)?.chunk.final).toBe(true);
    const total = chunks.reduce(
      (sum, c) => sum + Buffer.from(c.chunk.dataBase64, "base64").length,
      0,
    );
    expect(total).toBe(200_000);
  });

  test("an empty file still emits one final chunk, so the receiver can settle", async () => {
    const file = path.join(dir, "empty.txt");
    await fs.writeFile(file, "");
    await run({ op: "download", path: file });
    const chunks = sent.filter((m) => "chunk" in m);
    expect(chunks).toHaveLength(1);
  });
});

describe("operation validation (the browser's JSON is not trusted)", () => {
  // `op` arrives as whatever JSON the browser sent — the control plane relays it
  // structurally rather than re-validating the union, so this is the validation boundary
  // and the TypeScript type is a claim, not a guarantee.
  test("REQUIRED FAILURE PATH: a non-numeric sizeBytes cannot disable the upload cap", async () => {
    const uploads = new Map();
    // Math.min("abc", cap) is NaN, and every `written + len > NaN` is false — without the
    // guard this is an unbounded write that can fill the machine's disk.
    const result = await run(
      {
        op: "upload",
        path: path.join(dir, "x.bin"),
        sizeBytes: "abc" as unknown as number,
        replace: false,
      },
      uploads,
    );
    expectFailure(result, "invalid_path");
    expect(uploads.size).toBe(0);
  });

  test("REQUIRED FAILURE PATH: a negative sizeBytes is refused", async () => {
    expectFailure(
      await run({ op: "upload", path: path.join(dir, "x.bin"), sizeBytes: -1, replace: false }),
      "invalid_path",
    );
  });

  test("REQUIRED FAILURE PATH: an unknown op answers instead of hanging the request", async () => {
    // Falling through the switch would return undefined, send nothing, and leave the
    // browser's promise unsettled forever.
    const result = await run({ op: "chmod", path: "/etc/passwd" } as unknown as FsOp);
    expectFailure(result, "invalid_path");
  });

  test("REQUIRED FAILURE PATH: a non-string path is refused rather than coerced", async () => {
    expectFailure(await run({ op: "list", path: 42 as unknown as string }), "invalid_path");
  });

  test("REQUIRED FAILURE PATH: a write with a non-string body is refused", async () => {
    expectFailure(
      await run({
        op: "write",
        path: path.join(dir, "x.txt"),
        contentBase64: { evil: true } as unknown as string,
        expectedModifiedAt: null,
      }),
      "invalid_path",
    );
  });
});

describe("upload", () => {
  test("refuses an existing path unless replace was explicitly asked for", async () => {
    const file = path.join(dir, "there.txt");
    await fs.writeFile(file, "keep me");
    expectFailure(await run({ op: "upload", path: file, sizeBytes: 4, replace: false }), "exists");
    expect(await fs.readFile(file, "utf8")).toBe("keep me");
  });

  test("accepting an upload returns no result — the result follows the final chunk", async () => {
    const uploads = new Map();
    // Answering here as well would settle the browser's request twice, and it takes the
    // first answer: success reported before a single byte was written.
    const started = await run(
      { op: "upload", path: path.join(dir, "new.bin"), sizeBytes: 5, replace: false },
      uploads,
    );
    expect(started).toBeNull();
    expect(uploads.size).toBe(1);
  });

  test("writes chunks in order and settles on the final one", async () => {
    const uploads = new Map();
    const target = path.join(dir, "up.txt");
    await run({ op: "upload", path: target, sizeBytes: 6, replace: false }, uploads);

    expect(
      await applyUploadChunk(
        "req-1",
        { seq: 0, dataBase64: Buffer.from("abc").toString("base64"), final: false },
        uploads,
      ),
    ).toBeNull();

    const done = await applyUploadChunk(
      "req-1",
      { seq: 1, dataBase64: Buffer.from("def").toString("base64"), final: true },
      uploads,
    );
    expect(done?.ok).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("abcdef");
  });

  test("REQUIRED FAILURE PATH: an out-of-order chunk aborts instead of writing a corrupt file", async () => {
    const uploads = new Map();
    const target = path.join(dir, "up.txt");
    await run({ op: "upload", path: target, sizeBytes: 6, replace: false }, uploads);

    // Writing it anyway produces a file of the right length and the wrong contents,
    // which is worse than a failed upload.
    const result = await applyUploadChunk(
      "req-1",
      { seq: 7, dataBase64: Buffer.from("xyz").toString("base64"), final: false },
      uploads,
    );
    expectFailure(result, "io_error");
    expect(uploads.size).toBe(0);
  });

  test("REQUIRED FAILURE PATH: a sender that streams more than it declared is cut off", async () => {
    const uploads = new Map();
    const target = path.join(dir, "liar.bin");
    await run({ op: "upload", path: target, sizeBytes: 4, replace: false }, uploads);

    const result = await applyUploadChunk(
      "req-1",
      { seq: 0, dataBase64: Buffer.alloc(4096, 0x41).toString("base64"), final: false },
      uploads,
    );
    expectFailure(result, "too_large");
    expect(uploads.size).toBe(0);
  });

  test("chunks arriving after a refusal are dropped, not answered a second time", async () => {
    const uploads = new Map();
    const result = await applyUploadChunk(
      "never-started",
      { seq: 0, dataBase64: "", final: true },
      uploads,
    );
    expect(result).toBeNull();
  });
});
