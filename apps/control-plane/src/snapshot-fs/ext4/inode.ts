// Inodes: the mode, size and timestamps a listing shows, plus the 60 bytes that
// say where the file's data is.
import type { RangeReader } from "../range-reader";
import { readGroupDescriptor } from "./group";
import { Ext4FormatError, type Superblock } from "./superblock";

/** The root directory is always inode 2 on an ext4 filesystem. */
export const ROOT_INODE = 2;

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;

/** `i_block` holds an extent tree rather than legacy block pointers. */
const EXTENTS_FL = 0x80000;

/** Byte offset and length of `i_block` within an inode. */
const I_BLOCK_OFFSET = 0x28;
export const I_BLOCK_LENGTH = 60;

export type InodeKind = "file" | "directory" | "symlink" | "other";

export interface Inode {
  number: number;
  kind: InodeKind;
  /** Low 12 bits of `i_mode` — permissions, as `ls` would show them. */
  permissions: number;
  size: number;
  /** `i_mtime`, seconds since the epoch. */
  modifiedAtSeconds: number;
  usesExtents: boolean;
  /** 512-byte units. Zero means no data blocks at all, which is how a fast
   * symlink is told from one whose target needed a block. */
  blocks512: number;
  /** The raw 60 bytes: an extent tree, legacy block pointers, or a fast symlink's
   * target text. Which one is decided by `usesExtents` and `blocks512`. */
  iBlock: Uint8Array;
}

const kindOf = (mode: number): InodeKind => {
  switch (mode & S_IFMT) {
    case S_IFREG:
      return "file";
    case S_IFDIR:
      return "directory";
    case S_IFLNK:
      return "symlink";
    default:
      // Devices, sockets and FIFOs. Listed honestly as `other` rather than hidden
      // or mislabelled as files — there is nothing here to read, and a browser
      // that showed them as files would offer to open them.
      return "other";
  }
};

export const readInode = async (
  reader: RangeReader,
  superblock: Superblock,
  inodeNumber: number,
): Promise<Inode> => {
  if (inodeNumber < 1 || inodeNumber > superblock.inodeCount) {
    throw new Ext4FormatError(`inode ${inodeNumber} is outside the filesystem`);
  }

  // Inode numbers are 1-based, so the -1 is part of the addressing, not an off-by-one.
  const index = inodeNumber - 1;
  const group = Math.floor(index / superblock.inodesPerGroup);
  const withinGroup = index % superblock.inodesPerGroup;

  const descriptor = await readGroupDescriptor(reader, superblock, group);
  const offset =
    descriptor.inodeTableBlock * superblock.blockSize + withinGroup * superblock.inodeSize;

  const bytes = await reader.read(offset, superblock.inodeSize);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const mode = view.getUint16(0x00, true);
  const flags = view.getUint32(0x20, true);
  const sizeLo = view.getUint32(0x04, true);
  // `i_size_high` doubles as `i_dir_acl` on directories, where it is not a size.
  const sizeHi = (mode & S_IFMT) === S_IFDIR ? 0 : view.getUint32(0x6c, true);

  return {
    number: inodeNumber,
    kind: kindOf(mode),
    permissions: mode & 0o7777,
    size: sizeHi * 2 ** 32 + sizeLo,
    modifiedAtSeconds: view.getUint32(0x10, true),
    usesExtents: (flags & EXTENTS_FL) !== 0,
    blocks512: view.getUint32(0x1c, true),
    iBlock: bytes.slice(I_BLOCK_OFFSET, I_BLOCK_OFFSET + I_BLOCK_LENGTH),
  };
};

/** `ls`-style permission triplet, e.g. `rw-r--r--`, for `FsEntry.mode`.
 *
 * Display only, and on a snapshot it is display only in a stronger sense than on a live
 * machine: there is no uid here for the kernel to check these against. See
 * `filesystem.ts`'s header. */
export const formatPermissions = (permissions: number): string => {
  const triplet = (bits: number): string =>
    `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  return (
    triplet((permissions >> 6) & 7) + triplet((permissions >> 3) & 7) + triplet(permissions & 7)
  );
};
