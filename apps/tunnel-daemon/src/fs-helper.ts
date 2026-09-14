// ---------------------------------------------------------------------------
// The unprivileged half of a `method: "files"` session.
//
// This module runs in a SEPARATE PROCESS from the rest of the daemon, spawned
// through `su - <osUser>` by `files-session.ts`. That separation is the entire
// security property of the file interface, not an implementation detail:
//
//   The tunnel daemon runs as root, because it has to — `pty.ts` needs root to
//   drop into an arbitrary OS user. If filesystem operations ran in the daemon
//   process they would run as root too, and a `file_recovery` elevation would
//   then grant strictly MORE than a `shell` elevation: readable `/etc/shadow`,
//   readable secret material that the `cloudable` shell on the same machine
//   cannot touch. `docs/spec.md` §15 puts file recovery BELOW interactive shell
//   precisely because a shell can read injected secrets, and
//   `domain/elevation/policy.ts` charges a lower approval floor for it on that
//   basis. A root file browser would invert that ordering and make the cheaper
//   approval the more dangerous one.
//
// So: no privileged capability is exercised here, deliberately. Every operation
// below is a plain `node:fs/promises` call whose success or failure is decided
// by the OS against the uid this process was dropped to. There is no path
// allowlist and no chroot, and that is also deliberate — file recovery
// legitimately reaches `/etc` and `/var/log`, and a restriction the web
// terminal doesn't share would be theatre, not security. The OS permission
// model is the boundary, exactly as it is for a shell.
//
// Wire: newline-delimited JSON on stdin/stdout, one message per line. This is
// an INTERNAL protocol between the daemon and its own child, distinct from the
// `TunnelFrame` envelope on the websocket — `files-session.ts` translates. Kept
// separate so the frame format and the helper format can move independently,
// and so nothing the browser sends is ever handed to this process verbatim.
// ---------------------------------------------------------------------------
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as readline from "node:readline";
import {
  FS_CHUNK_BYTES,
  FS_MAX_ENTRIES,
  FS_MAX_INLINE_BYTES,
  FS_MAX_TRANSFER_BYTES,
  type FsEntry,
  type FsEntryType,
  type FsFailureReason,
  type FsOp,
  type FsResult,
} from "@cloudable/contracts";

/** Daemon -> helper. Either a new operation, or one slice of an in-progress upload. */
export type HelperRequest =
  | { id: string; op: FsOp }
  | { id: string; chunk: { seq: number; dataBase64: string; final: boolean } };

/** Helper -> daemon. A terminal result, or one slice of an in-progress download. */
export type HelperMessage =
  | { id: string; result: FsResult }
  | { id: string; chunk: { seq: number; dataBase64: string; final: boolean } };

/**
 * Maps a Node `errno` to the fixed vocabulary in `FsFailureReason`.
 *
 * The raw error is never forwarded. Errno strings carry absolute paths and
 * internals, and these results are rendered in a browser and travel through the
 * control plane's logs on the way — the same rule `AttestationError` follows for
 * credentials, for the same reason. `io_error` is the deliberate catch-all: a
 * reason the UI can show honestly without inventing a specific cause.
 */
export function reasonForError(error: unknown): FsFailureReason {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "ENOTDIR":
      return "not_a_directory";
    case "EISDIR":
      return "is_a_directory";
    case "EEXIST":
      return "exists";
    case "ENAMETOOLONG":
    case "EINVAL":
      return "invalid_path";
    case "EFBIG":
      return "too_large";
    default:
      return "io_error";
  }
}

/** `ls`-style permission triplet from a stat mode, e.g. `"rw-r--r--"`. Display only. */
export function formatMode(mode: number): string {
  const bits = ["r", "w", "x"];
  let out = "";
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let bit = 0; bit < 3; bit++) {
      out += mode & (1 << (shift + (2 - bit))) ? bits[bit] : "-";
    }
  }
  return out;
}

function entryTypeOf(stats: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): FsEntryType {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

/**
 * Absolute, normalised, and with any trailing slash removed (except at `/`).
 * Rejects a relative path outright rather than resolving it against whatever
 * the helper's cwd happens to be, which would make the same request mean
 * different things depending on where `su` dropped us.
 */
export function normalisePath(input: string): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  if (!input.startsWith("/")) return null;
  if (input.includes("\0")) return null;
  return nodePath.posix.normalize(input).replace(/(.)\/+$/, "$1");
}

/** `null` at the filesystem root, which has no parent to navigate up to. */
export function parentOf(path: string): string | null {
  if (path === "/") return null;
  return nodePath.posix.dirname(path);
}

/**
 * A NUL byte in the first slice is the same heuristic `grep` and `git` use to
 * call a file binary. It matters because the editor round-trips content through
 * a JavaScript string: a file that isn't valid text would come back subtly
 * different from what went in, and saving it would corrupt it silently. Refusing
 * up front is the only honest option — the file is still downloadable.
 */
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** One upload in flight: an open handle plus the seq we expect next. */
interface PendingUpload {
  handle: fs.FileHandle;
  path: string;
  nextSeq: number;
  written: number;
  declaredSize: number;
}

export interface HelperIo {
  send: (message: HelperMessage) => void;
}

/**
 * Shape-checks one operation before it is acted on.
 *
 * `op` reaches this process as whatever JSON the browser put in an `fs_request` frame. The
 * control plane relays that structurally rather than re-validating `FsOp` field by field
 * (a second copy of the union there would drift from `packages/contracts`), so this is the
 * validation boundary and the TypeScript type is a claim, not a guarantee.
 *
 * Two concrete failures this prevents, both reachable by anyone who can open a files
 * session — which is every machine owner:
 *
 *  - A non-numeric `sizeBytes` on an upload. `Math.min("abc", cap)` is `NaN`, every
 *    `written + len > NaN` comparison is false, and the transfer cap silently disappears:
 *    an unbounded write that can fill the machine's disk.
 *  - An unrecognised `op`. The switch below would fall through and return `undefined`,
 *    nothing would be sent, and the browser's request would hang unanswered forever.
 */
function invalidOp(op: FsOp): boolean {
  const known = ["list", "read", "write", "mkdir", "rename", "download", "upload"];
  if (!op || typeof op !== "object" || !known.includes(op.op)) return true;
  if (op.op === "upload") {
    return !Number.isFinite(op.sizeBytes) || op.sizeBytes < 0 || typeof op.replace !== "boolean";
  }
  if (op.op === "write") {
    return (
      typeof op.contentBase64 !== "string" ||
      (op.expectedModifiedAt !== null && typeof op.expectedModifiedAt !== "string")
    );
  }
  return false;
}

/**
 * Executes one operation.
 *
 * Returns the terminal result, or `null` when the operation is only STARTING and its
 * result comes later — which is exactly the accepted-upload case: the result is sent once
 * the final chunk is durably written (`applyUploadChunk`), so the browser's "uploaded"
 * state reflects bytes on disk rather than a request merely accepted. Sending a result
 * here as well would answer the same `requestId` twice, and the browser settles on the
 * first answer — reporting success before a single byte had been written.
 *
 * A `download` streams `chunk` messages through `io` before its result is returned, so the
 * caller sees bytes first and completion last.
 */
export async function runOperation(
  id: string,
  op: FsOp,
  io: HelperIo,
  uploads: Map<string, PendingUpload>,
): Promise<FsResult | null> {
  if (invalidOp(op)) return { ok: false, reason: "invalid_path" };

  switch (op.op) {
    case "list": {
      const path = normalisePath(op.path);
      if (!path) return { ok: false, reason: "invalid_path" };
      const dirents = await fs.readdir(path, { withFileTypes: true });
      const truncated = dirents.length > FS_MAX_ENTRIES;
      const slice = truncated ? dirents.slice(0, FS_MAX_ENTRIES) : dirents;

      const entries: FsEntry[] = [];
      for (const dirent of slice) {
        const full = nodePath.posix.join(path, dirent.name);
        try {
          // `lstat`, not `stat`: a symlink is shown as itself with its target, rather
          // than silently wearing the stats of whatever it points at. A broken link
          // then lists normally instead of vanishing behind an ENOENT.
          const stats = await fs.lstat(full);
          const type = entryTypeOf(stats);
          entries.push({
            name: dirent.name,
            type,
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            mode: formatMode(stats.mode),
            symlinkTarget: type === "symlink" ? await fs.readlink(full).catch(() => null) : null,
          });
        } catch {
          // One unreadable entry must not fail the whole listing — a directory the
          // session user can read often contains entries it cannot stat.
        }
      }
      entries.sort((a, b) =>
        a.type === b.type || (a.type !== "directory" && b.type !== "directory")
          ? a.name.localeCompare(b.name)
          : a.type === "directory"
            ? -1
            : 1,
      );
      return { ok: true, op: "list", path, parent: parentOf(path), entries, truncated };
    }

    case "read": {
      const path = normalisePath(op.path);
      if (!path) return { ok: false, reason: "invalid_path" };
      const stats = await fs.stat(path);
      if (stats.isDirectory()) return { ok: false, reason: "is_a_directory" };
      if (stats.size > FS_MAX_INLINE_BYTES) return { ok: false, reason: "too_large" };
      const bytes = new Uint8Array(await fs.readFile(path));
      if (looksBinary(bytes)) return { ok: false, reason: "is_binary" };
      return {
        ok: true,
        op: "read",
        path,
        contentBase64: toBase64(bytes),
        modifiedAt: stats.mtime.toISOString(),
        sizeBytes: stats.size,
      };
    }

    case "write": {
      const path = normalisePath(op.path);
      if (!path) return { ok: false, reason: "invalid_path" };
      const bytes = new Uint8Array(Buffer.from(op.contentBase64, "base64"));
      if (bytes.length > FS_MAX_INLINE_BYTES) return { ok: false, reason: "too_large" };

      if (op.expectedModifiedAt !== null) {
        // Lost-update check. Without it, two people editing the same file through
        // two sessions silently overwrite each other, and the loser has no way to
        // even know it happened. Compared as an ISO string because that is exactly
        // what was handed out in the `read` result — no clock or precision
        // assumptions beyond "the same value came back".
        const current = await fs.stat(path).catch(() => null);
        if (current && current.mtime.toISOString() !== op.expectedModifiedAt) {
          return { ok: false, reason: "changed_on_disk" };
        }
      }

      await fs.writeFile(path, bytes);
      const after = await fs.stat(path);
      return {
        ok: true,
        op: "write",
        path,
        modifiedAt: after.mtime.toISOString(),
        sizeBytes: after.size,
      };
    }

    case "mkdir": {
      const path = normalisePath(op.path);
      if (!path) return { ok: false, reason: "invalid_path" };
      // Not recursive: a typo in a deep path should fail loudly rather than
      // quietly building a tree nobody asked for.
      await fs.mkdir(path);
      return { ok: true, op: "mkdir", path };
    }

    case "rename": {
      const from = normalisePath(op.from);
      const to = normalisePath(op.to);
      if (!from || !to) return { ok: false, reason: "invalid_path" };
      // `fs.rename` overwrites an existing destination without complaint. There is
      // no delete operation in this interface, so a silent clobber here would be
      // the one unrecoverable action available — check first.
      const existing = await fs.lstat(to).catch(() => null);
      if (existing) return { ok: false, reason: "exists" };
      await fs.rename(from, to);
      return { ok: true, op: "rename", from, to };
    }

    case "download": {
      const path = normalisePath(op.path);
      if (!path) return { ok: false, reason: "invalid_path" };
      const stats = await fs.stat(path);
      if (stats.isDirectory()) return { ok: false, reason: "is_a_directory" };
      if (stats.size > FS_MAX_TRANSFER_BYTES) return { ok: false, reason: "too_large" };

      const handle = await fs.open(path, "r");
      try {
        const buffer = Buffer.allocUnsafe(FS_CHUNK_BYTES);
        let seq = 0;
        let offset = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, FS_CHUNK_BYTES, offset);
          offset += bytesRead;
          const final = bytesRead === 0 || offset >= stats.size;
          io.send({
            id,
            chunk: { seq, dataBase64: toBase64(buffer.subarray(0, bytesRead)), final },
          });
          seq++;
          if (final) break;
        }
      } finally {
        await handle.close();
      }
      return { ok: true, op: "download", path, sizeBytes: stats.size };
    }

    case "upload": {
      const path = normalisePath(op.path);
      if (!path) return { ok: false, reason: "invalid_path" };
      if (op.sizeBytes > FS_MAX_TRANSFER_BYTES) return { ok: false, reason: "too_large" };
      if (!op.replace) {
        const existing = await fs.lstat(path).catch(() => null);
        if (existing) return { ok: false, reason: "exists" };
      }
      // `w` truncates, which is what a confirmed replace means. The result is not
      // sent now — it follows the final chunk, so the browser's "uploaded" state
      // reflects bytes actually on disk rather than a request merely accepted.
      const handle = await fs.open(path, "w");
      uploads.set(id, { handle, path, nextSeq: 0, written: 0, declaredSize: op.sizeBytes });
      return null;
    }
    default:
      // Unreachable given `invalidOp` above, which is the point: an unknown op must
      // produce an answer rather than leaving the caller's request unsettled.
      return { ok: false, reason: "invalid_path" };
  }
}

/** Applies one uploaded slice. Returns a result only once the upload completes or fails. */
export async function applyUploadChunk(
  id: string,
  chunk: { seq: number; dataBase64: string; final: boolean },
  uploads: Map<string, PendingUpload>,
): Promise<FsResult | null> {
  const pending = uploads.get(id);
  // No pending upload means this request already settled — refused up front (`exists`,
  // `too_large`), or failed part-way and closed its handle. The sender fires chunks
  // without waiting for an ack, so trailing frames after a refusal are expected, not an
  // error. Dropping them silently is right; answering would be a second result for a
  // `requestId` that already has one.
  if (!pending) return null;

  const fail = async (reason: FsFailureReason): Promise<FsResult> => {
    uploads.delete(id);
    await pending.handle.close().catch(() => {});
    return { ok: false, reason };
  };

  // Out of order means the stream is not what the sender thinks it is. Writing it
  // anyway would produce a file that is the right length and the wrong contents,
  // which is worse than a failed upload.
  if (chunk.seq !== pending.nextSeq) return fail("io_error");

  const bytes = new Uint8Array(Buffer.from(chunk.dataBase64, "base64"));
  // Against the size the sender DECLARED, not just the global cap: an upload that declared
  // 10 bytes and then streams 50 MiB is not a large upload, it is a sender that is lying,
  // and the declared size is what the refusal decision was made against.
  if (pending.written + bytes.length > Math.min(pending.declaredSize, FS_MAX_TRANSFER_BYTES)) {
    return fail("too_large");
  }

  try {
    await pending.handle.write(bytes);
  } catch (error) {
    return fail(reasonForError(error));
  }
  pending.nextSeq++;
  pending.written += bytes.length;

  if (!chunk.final) return null;

  uploads.delete(id);
  await pending.handle.close();
  return { ok: true, op: "upload", path: pending.path };
}

/**
 * The helper's main loop. Reads NDJSON on stdin until it closes, which is how the
 * daemon ends a session: killing the child, or simply dropping the pipe.
 *
 * Every operation is wrapped — an unexpected throw becomes a typed failure for
 * that one request rather than taking the process down and, with it, the whole
 * file session.
 */
export async function runFsHelper(input: NodeJS.ReadableStream, io: HelperIo): Promise<void> {
  const uploads = new Map<string, PendingUpload>();
  const rl = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of rl) {
    if (line.length === 0) continue;
    let request: HelperRequest;
    try {
      request = JSON.parse(line) as HelperRequest;
    } catch {
      continue;
    }
    if (typeof request?.id !== "string") continue;

    try {
      if ("op" in request) {
        const result = await runOperation(request.id, request.op, io, uploads);
        if (result) io.send({ id: request.id, result });
      } else if ("chunk" in request) {
        const result = await applyUploadChunk(request.id, request.chunk, uploads);
        if (result) io.send({ id: request.id, result });
      }
    } catch (error) {
      io.send({ id: request.id, result: { ok: false, reason: reasonForError(error) } });
    }
  }

  for (const pending of uploads.values()) await pending.handle.close().catch(() => {});
}

/** Entry point when the daemon binary is re-executed with `--fs-helper`. */
export async function main(): Promise<void> {
  await runFsHelper(process.stdin, {
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  });
}
