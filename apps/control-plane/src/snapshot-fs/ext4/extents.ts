// ---------------------------------------------------------------------------
// The extent tree: logical file block -> physical disk block.
//
// An inode's 60 `i_block` bytes hold a 12-byte header and room for four
// entries. A file needing more gets a tree: the header's `depth` is non-zero,
// the entries are indices pointing at blocks that hold another header and more
// entries, and so on down to depth 0 where the entries are real extents.
//
// Two things here are easy to get wrong and both are silent when you do. A
// logical block covered by NO extent is a hole and reads as zeroes rather than
// as an error — sparse files are ordinary. And an extent whose length is over
// 32768 is an UNINITIALISED extent: it is allocated but never written, its
// length is `len - 32768`, and its contents must be read as zeroes rather than
// as whatever was on the disk before. Returning that stale data would leak the
// previous tenant of those blocks into a file listing.
// ---------------------------------------------------------------------------
import type { RangeReader } from "../range-reader";
import { Ext4FormatError, type Superblock } from "./superblock";

const EXTENT_MAGIC = 0xf30a;
const EXTENT_HEADER_SIZE = 12;
const EXTENT_ENTRY_SIZE = 12;
const UNINITIALISED_LENGTH_LIMIT = 32768;

/** A contiguous run of file blocks, resolved to where they live on the disk. */
export interface Extent {
  /** First file-relative block this run covers. */
  logicalBlock: number;
  /** First disk block it maps to. */
  physicalBlock: number;
  blockCount: number;
  /** Allocated but never written: reads as zeroes, never as what is on the disk. */
  uninitialised: boolean;
}

interface ExtentHeader {
  entries: number;
  depth: number;
}

const readHeader = (view: DataView, offset: number): ExtentHeader => {
  const magic = view.getUint16(offset, true);
  if (magic !== EXTENT_MAGIC) {
    throw new Ext4FormatError(`extent node has magic 0x${magic.toString(16)}, expected 0xf30a`);
  }
  return {
    entries: view.getUint16(offset + 2, true),
    depth: view.getUint16(offset + 6, true),
  };
};

/**
 * Every extent in one inode's tree, in logical order.
 *
 * `maxNodes` bounds the walk. A corrupt or hostile image can point an index at a block
 * that leads back into the tree, and an unbounded walk would spin issuing disk reads
 * forever. The limit is generous enough that no real file reaches it.
 */
export const readExtents = async (
  reader: RangeReader,
  superblock: Superblock,
  iBlock: Uint8Array,
  options: { maxNodes?: number } = {},
): Promise<Extent[]> => {
  const maxNodes = options.maxNodes ?? 4096;
  let nodesRead = 0;
  const extents: Extent[] = [];

  const walk = async (node: Uint8Array): Promise<void> => {
    if (++nodesRead > maxNodes) {
      throw new Ext4FormatError("extent tree is too large or contains a cycle");
    }
    const view = new DataView(node.buffer, node.byteOffset, node.byteLength);
    const header = readHeader(view, 0);

    const capacity = Math.floor((node.byteLength - EXTENT_HEADER_SIZE) / EXTENT_ENTRY_SIZE);
    if (header.entries > capacity) {
      throw new Ext4FormatError(
        `extent node claims ${header.entries} entries but holds at most ${capacity}`,
      );
    }

    for (let i = 0; i < header.entries; i++) {
      const at = EXTENT_HEADER_SIZE + i * EXTENT_ENTRY_SIZE;

      if (header.depth === 0) {
        const rawLength = view.getUint16(at + 4, true);
        const uninitialised = rawLength > UNINITIALISED_LENGTH_LIMIT;
        extents.push({
          logicalBlock: view.getUint32(at, true),
          physicalBlock: view.getUint16(at + 6, true) * 2 ** 32 + view.getUint32(at + 8, true),
          blockCount: uninitialised ? rawLength - UNINITIALISED_LENGTH_LIMIT : rawLength,
          uninitialised,
        });
        continue;
      }

      const childBlock = view.getUint16(at + 8, true) * 2 ** 32 + view.getUint32(at + 4, true);
      if (childBlock === 0 || childBlock >= superblock.blockCount) {
        throw new Ext4FormatError(`extent index points outside the filesystem: ${childBlock}`);
      }
      const child = await reader.read(childBlock * superblock.blockSize, superblock.blockSize);
      await walk(child);
    }
  };

  await walk(iBlock);
  extents.sort((a, b) => a.logicalBlock - b.logicalBlock);
  return extents;
};

/**
 * `length` bytes of a file's contents starting at `offset`.
 *
 * Holes and uninitialised extents both come back as zeroes, which is what the kernel
 * would return for the same read.
 */
export const readFileRange = async (
  reader: RangeReader,
  superblock: Superblock,
  extents: ReadonlyArray<Extent>,
  offset: number,
  length: number,
): Promise<Uint8Array> => {
  const out = new Uint8Array(length);
  const { blockSize } = superblock;

  const firstBlock = Math.floor(offset / blockSize);
  const lastBlock = Math.floor((offset + length - 1) / blockSize);

  for (const extent of extents) {
    if (extent.uninitialised) continue;

    const from = Math.max(extent.logicalBlock, firstBlock);
    const to = Math.min(extent.logicalBlock + extent.blockCount - 1, lastBlock);
    if (from > to) continue;

    // One read per contiguous run rather than one per block: an extent is contiguous
    // on disk by definition, and a 2 MiB file would otherwise be 512 round trips.
    const runStart = (extent.physicalBlock + (from - extent.logicalBlock)) * blockSize;
    const runBytes = await reader.read(runStart, (to - from + 1) * blockSize);

    const runFileOffset = from * blockSize;
    const copyFrom = Math.max(0, offset - runFileOffset);
    const copyTo = Math.min(runBytes.byteLength, offset + length - runFileOffset);
    if (copyTo <= copyFrom) continue;

    out.set(runBytes.subarray(copyFrom, copyTo), runFileOffset + copyFrom - offset);
  }

  return out;
};
