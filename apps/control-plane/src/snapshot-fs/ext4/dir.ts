// ---------------------------------------------------------------------------
// Directory entries.
//
// A directory's data blocks are a chain of variable-length records: inode
// number, record length, name length, type byte, name. Walk to the end of one
// record to find the next.
//
// Large directories additionally carry a hash index (`dir_index`, on by default
// and on in every filesystem this reads). It needs no special handling here,
// and the reason is worth stating because it looks like it should: the index
// blocks are hidden behind a record whose inode number is 0 and whose length
// covers the rest of the block. Walking linearly and skipping records with
// inode 0 steps straight over the hash data — the same thing the kernel's own
// non-indexed readdir path does.
// ---------------------------------------------------------------------------
import type { RangeReader } from "../range-reader";
import { readExtents, readFileRange } from "./extents";
import type { Inode } from "./inode";
import { Ext4FormatError, type Superblock } from "./superblock";

const DIRENT_HEADER_SIZE = 8;

/** `file_type`, present only with the `filetype` feature. */
const FILE_TYPE_REGULAR = 1;
const FILE_TYPE_DIRECTORY = 2;
const FILE_TYPE_SYMLINK = 7;

export interface DirectoryEntry {
  name: string;
  inodeNumber: number;
  /** From the dirent's own type byte when the filesystem records one. Null means the
   * caller must read the inode to find out — correct, just an extra read. */
  kindHint: "file" | "directory" | "symlink" | "other" | null;
}

const kindFromFileType = (value: number): DirectoryEntry["kindHint"] => {
  switch (value) {
    case FILE_TYPE_REGULAR:
      return "file";
    case FILE_TYPE_DIRECTORY:
      return "directory";
    case FILE_TYPE_SYMLINK:
      return "symlink";
    default:
      return "other";
  }
};

/**
 * Reads a directory inode's entries, `.` and `..` included — callers filter those,
 * because which of them is noise depends on what the caller is doing.
 *
 * `limit` stops the walk early. A directory with more entries than a caller will show is
 * common (the fixture has one with 12,000), and reading all of them to throw most away
 * costs real disk reads.
 */
export const readDirectory = async (
  reader: RangeReader,
  superblock: Superblock,
  inode: Inode,
  options: { limit?: number } = {},
): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> => {
  if (inode.kind !== "directory") {
    throw new Ext4FormatError(`inode ${inode.number} is not a directory`);
  }

  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const extents = await readExtents(reader, superblock, inode.iBlock);
  const entries: DirectoryEntry[] = [];
  const decoder = new TextDecoder();

  const blockCount = Math.ceil(inode.size / superblock.blockSize);
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const block = await readFileRange(
      reader,
      superblock,
      extents,
      blockIndex * superblock.blockSize,
      superblock.blockSize,
    );
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);

    let at = 0;
    while (at + DIRENT_HEADER_SIZE <= block.byteLength) {
      const inodeNumber = view.getUint32(at, true);
      const recordLength = view.getUint16(at + 4, true);

      // A zero or unaligned record length cannot advance the walk and would spin.
      // Treat it as the end of this block rather than failing the whole listing:
      // one damaged block should not make an otherwise readable directory unreadable.
      if (recordLength < DIRENT_HEADER_SIZE || recordLength % 4 !== 0) break;
      if (at + recordLength > block.byteLength) break;

      if (inodeNumber !== 0) {
        const nameLength = view.getUint8(at + 6);
        const typeByte = view.getUint8(at + 7);
        if (nameLength > 0 && at + DIRENT_HEADER_SIZE + nameLength <= block.byteLength) {
          entries.push({
            name: decoder.decode(
              block.subarray(at + DIRENT_HEADER_SIZE, at + DIRENT_HEADER_SIZE + nameLength),
            ),
            inodeNumber,
            kindHint: superblock.hasFiletype ? kindFromFileType(typeByte) : null,
          });
          if (entries.length >= limit) return { entries, truncated: true };
        }
      }

      at += recordLength;
    }
  }

  return { entries, truncated: false };
};
