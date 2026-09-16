import posix from "node:path/posix";
// ---------------------------------------------------------------------------
// The read-only filesystem a snapshot inspection session talks to.
//
// Speaks the same `FsOp`/`FsResult` vocabulary as a live files session
// (`packages/contracts/src/domains/tunnel.ts`), so the console's file browser
// works against either. Only the three READ operations exist: `list`, `read`,
// `download`. There is no write path here to leave half-built — a snapshot is
// a fixed historical copy, and the one thing nobody should be able to do to it
// is change it.
//
// TWO THINGS THAT ARE NOT LIKE A LIVE MACHINE, both deliberate:
//
// 1. Permissions are reported, never enforced. On a machine, file operations
//    run as an unprivileged OS user and the kernel decides what they may
//    touch (`apps/tunnel-daemon/src/fs-helper.ts`). Here there is no process
//    and no uid — just bytes and a parser — so every byte on the disk is
//    readable to anyone who gets this far. `FsEntry.mode` is shown because it
//    is useful evidence about the live machine, not because it is applied.
//    The access gate in `domain/archive/inspect-authorization.ts` is therefore
//    the whole of the security story, which is why it is the part with the
//    tests.
//
// 2. Paths are the MACHINE's paths, not the image's. This image is the
//    persistent disk, which is mounted at /home (see `homeVolumeSection()`),
//    so the image's root directory is /home. Presenting image-relative paths
//    would show someone `/cloudable/notes.txt` for a file they know as
//    `/home/cloudable/notes.txt`. The prefix is added on the way out and
//    stripped on the way in.
// ---------------------------------------------------------------------------
import {
  FS_MAX_ENTRIES,
  FS_MAX_INLINE_BYTES,
  FS_MAX_TRANSFER_BYTES,
  type FsEntry,
  type FsFailureReason,
  type FsResult,
} from "@cloudable/contracts";
import type { RangeReader } from "../range-reader";
import { readDirectory } from "./dir";
import { readExtents, readFileRange } from "./extents";
import { type Inode, ROOT_INODE, formatPermissions, readInode } from "./inode";
import { type Superblock, readSuperblock } from "./superblock";

/** Where this disk is mounted on the machine it came from. */
export const DISK_MOUNT_PATH = "/home";

/** How many symlinks one lookup will follow before giving up. */
const MAX_SYMLINK_DEPTH = 8;

/** How much of a file is inspected for NUL bytes before calling it binary — the same
 * window `fs-helper.ts`'s `looksBinary` uses, so the two surfaces agree about which
 * files open in an editor. */
const BINARY_SNIFF_BYTES = 8000;

class FsFailure extends Error {
  constructor(readonly reason: FsFailureReason) {
    super(reason);
    this.name = "FsFailure";
  }
}

/**
 * Absolute, NUL-free, normalised — the same rules `fs-helper.ts` applies on a live
 * machine, for the same reasons. Returns the path relative to the image root, so
 * `/home/cloudable/x` becomes `cloudable/x` and `/home` becomes `""`.
 */
const toImagePath = (input: string): string => {
  if (typeof input !== "string" || input.length === 0) throw new FsFailure("invalid_path");
  if (!input.startsWith("/")) throw new FsFailure("invalid_path");
  if (input.includes("\0")) throw new FsFailure("invalid_path");

  const normalised = posix.normalize(input).replace(/(.)\/+$/, "$1");
  if (normalised === DISK_MOUNT_PATH) return "";
  if (!normalised.startsWith(`${DISK_MOUNT_PATH}/`)) {
    // A real path on the machine, just not one on this disk. `/etc/nginx` lives on
    // the OS disk, which this snapshot does not contain and v1 does not read.
    throw new FsFailure("not_found");
  }
  return normalised.slice(DISK_MOUNT_PATH.length + 1);
};

const toMachinePath = (imagePath: string): string =>
  imagePath === "" ? DISK_MOUNT_PATH : `${DISK_MOUNT_PATH}/${imagePath}`;

/** The parent of an image path, or null at the image root. `posix.dirname` answers "."
 * for a bare top-level name, which would render as `/home/.` — a path that works but
 * that nobody should ever be shown. */
const parentImagePath = (imagePath: string): string | null => {
  if (imagePath === "") return null;
  const cut = imagePath.lastIndexOf("/");
  return cut === -1 ? "" : imagePath.slice(0, cut);
};

/**
 * `FsResult` narrowed to the one operation each method can actually answer with.
 *
 * `FsResult` covers every op a LIVE session has, `write` and `upload` among them. Leaving
 * these as the full union would let a handler declare a wire shape that says a listing
 * might come back as a write receipt — and would quietly hide the fact that this
 * filesystem has no write path at all.
 */
export type FsFailureResult = Extract<FsResult, { ok: false }>;
export type FsListResult = Extract<FsResult, { ok: true; op: "list" }> | FsFailureResult;
export type FsReadResult = Extract<FsResult, { ok: true; op: "read" }> | FsFailureResult;
export type FsDownloadResult = Extract<FsResult, { ok: true; op: "download" }> | FsFailureResult;

export interface SnapshotFilesystem {
  list(path: string, limit?: number): Promise<FsListResult>;
  read(path: string): Promise<FsReadResult>;
  download(path: string): Promise<{ result: FsDownloadResult; bytes?: Uint8Array }>;
}

export const openExt4Filesystem = async (reader: RangeReader): Promise<SnapshotFilesystem> => {
  const superblock: Superblock = await readSuperblock(reader);

  const contentsOf = async (inode: Inode, length: number): Promise<Uint8Array> => {
    if (length === 0) return new Uint8Array(0);
    if (!inode.usesExtents) {
      // Legacy block-mapped inodes. `mkfs.ext4` has produced extent-mapped inodes by
      // default for over a decade and every machine this reads is provisioned by
      // `homeVolumeSection()`, so this would mean an image built elsewhere. Refusing
      // is honest; half-reading it via the wrong interpretation of `i_block` is not.
      throw new FsFailure("io_error");
    }
    const extents = await readExtents(reader, superblock, inode.iBlock);
    return readFileRange(reader, superblock, extents, 0, length);
  };

  const symlinkTarget = async (inode: Inode): Promise<string> => {
    // A target short enough to fit lives in the 60 bytes of `i_block` itself, with no
    // data block allocated — which is exactly what `blocks512 === 0` reports.
    const raw =
      inode.blocks512 === 0
        ? inode.iBlock.subarray(0, Math.min(inode.size, inode.iBlock.byteLength))
        : await contentsOf(inode, inode.size);
    return new TextDecoder().decode(raw);
  };

  /** Walks `imagePath` from the root, following symlinks on intermediate components. */
  const resolve = async (imagePath: string, depth = 0): Promise<Inode> => {
    if (depth > MAX_SYMLINK_DEPTH) throw new FsFailure("io_error");

    let current = await readInode(reader, superblock, ROOT_INODE);
    const parts = imagePath.split("/").filter((part) => part.length > 0);

    for (const [index, part] of parts.entries()) {
      if (current.kind === "symlink") {
        current = await resolve(await followLink(current, parts.slice(0, index)), depth + 1);
      }
      if (current.kind !== "directory") throw new FsFailure("not_a_directory");

      const { entries } = await readDirectory(reader, superblock, current);
      const match = entries.find((entry) => entry.name === part);
      if (!match) throw new FsFailure("not_found");
      current = await readInode(reader, superblock, match.inodeNumber);
    }
    return current;
  };

  /** A symlink's target, re-expressed as an image path. */
  const followLink = async (inode: Inode, parentParts: string[]): Promise<string> => {
    const target = await symlinkTarget(inode);
    if (target.startsWith("/")) {
      // Absolute targets are machine paths. One into /home lands back on this disk;
      // anything else points at a disk this snapshot does not contain.
      return toImagePath(target);
    }
    return posix.normalize(posix.join(parentParts.join("/"), target)).replace(/^\.\//, "");
  };

  const entryFor = async (name: string, inodeNumber: number): Promise<FsEntry> => {
    const inode = await readInode(reader, superblock, inodeNumber);
    return {
      name,
      type: inode.kind,
      sizeBytes: inode.size,
      modifiedAt: new Date(inode.modifiedAtSeconds * 1000).toISOString(),
      mode: formatPermissions(inode.permissions),
      symlinkTarget: inode.kind === "symlink" ? await symlinkTarget(inode) : null,
    };
  };

  const settle = async <R extends FsResult>(
    run: () => Promise<R>,
  ): Promise<R | FsFailureResult> => {
    try {
      return await run();
    } catch (error) {
      // A fixed reason vocabulary, never the raw parser message — the same rule the
      // live path follows, and for a sharper reason here: a parse error's text can
      // carry byte offsets and internal structure of someone else's disk.
      return { ok: false, reason: error instanceof FsFailure ? error.reason : "io_error" };
    }
  };

  return {
    list: (path, limit = FS_MAX_ENTRIES) =>
      settle<Extract<FsResult, { ok: true; op: "list" }>>(async () => {
        const imagePath = toImagePath(path);
        let inode = await resolve(imagePath);
        if (inode.kind === "symlink") {
          inode = await resolve(await followLink(inode, imagePath.split("/").slice(0, -1)));
        }
        if (inode.kind !== "directory") throw new FsFailure("not_a_directory");

        // +2 because `.` and `..` are real entries on disk and are dropped below; without
        // it a directory of exactly `limit` entries would report itself truncated.
        const { entries, truncated } = await readDirectory(reader, superblock, inode, {
          limit: limit + 2,
        });
        const named = entries.filter((entry) => entry.name !== "." && entry.name !== "..");

        const resolved: FsEntry[] = [];
        for (const entry of named.slice(0, limit)) {
          resolved.push(await entryFor(entry.name, entry.inodeNumber));
        }
        resolved.sort((a, b) => a.name.localeCompare(b.name));

        return {
          ok: true,
          op: "list",
          path: toMachinePath(imagePath),
          parent: (() => {
            const parent = parentImagePath(imagePath);
            return parent === null ? null : toMachinePath(parent);
          })(),
          entries: resolved,
          truncated: truncated || named.length > limit,
        };
      }),

    read: (path) =>
      settle<Extract<FsResult, { ok: true; op: "read" }>>(async () => {
        const imagePath = toImagePath(path);
        let inode = await resolve(imagePath);
        if (inode.kind === "symlink") {
          inode = await resolve(await followLink(inode, imagePath.split("/").slice(0, -1)));
        }
        if (inode.kind === "directory") throw new FsFailure("is_a_directory");
        if (inode.kind !== "file") throw new FsFailure("not_found");
        if (inode.size > FS_MAX_INLINE_BYTES) throw new FsFailure("too_large");

        const bytes = await contentsOf(inode, inode.size);
        if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new FsFailure("is_binary");

        return {
          ok: true,
          op: "read",
          path: toMachinePath(imagePath),
          contentBase64: Buffer.from(bytes).toString("base64"),
          modifiedAt: new Date(inode.modifiedAtSeconds * 1000).toISOString(),
          sizeBytes: inode.size,
        };
      }),

    download: async (path) => {
      let bytes: Uint8Array | undefined;
      const result = await settle<Extract<FsResult, { ok: true; op: "download" }>>(async () => {
        const imagePath = toImagePath(path);
        let inode = await resolve(imagePath);
        if (inode.kind === "symlink") {
          inode = await resolve(await followLink(inode, imagePath.split("/").slice(0, -1)));
        }
        if (inode.kind === "directory") throw new FsFailure("is_a_directory");
        if (inode.kind !== "file") throw new FsFailure("not_found");
        if (inode.size > FS_MAX_TRANSFER_BYTES) throw new FsFailure("too_large");

        bytes = await contentsOf(inode, inode.size);
        return {
          ok: true,
          op: "download",
          path: toMachinePath(imagePath),
          sizeBytes: inode.size,
        };
      });
      return bytes ? { result, bytes } : { result };
    },
  };
};
