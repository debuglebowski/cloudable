// Block group descriptors — the table that says where each group's inode table
// lives. One lookup stands between an inode number and its bytes.
import type { RangeReader } from "../range-reader";
import { Ext4FormatError, type Superblock } from "./superblock";

/** Only the field anything here needs: where this group's inode table starts. */
export interface GroupDescriptor {
  inodeTableBlock: number;
}

/**
 * The descriptor table begins in the block after the one holding the superblock.
 * `s_first_data_block` is 1 on a 1 KiB-block filesystem (where the superblock has a
 * block to itself) and 0 otherwise, which is what makes this arithmetic rather than a
 * constant.
 */
export const readGroupDescriptor = async (
  reader: RangeReader,
  superblock: Superblock,
  group: number,
): Promise<GroupDescriptor> => {
  const tableStart = (superblock.firstDataBlock + 1) * superblock.blockSize;
  const offset = tableStart + group * superblock.descriptorSize;
  const bytes = await reader.read(offset, superblock.descriptorSize);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const lo = view.getUint32(0x08, true);
  // The high half only exists on a 64bit filesystem with descriptors big enough to
  // hold it; reading offset 0x28 of a 32-byte descriptor would be someone else's field.
  const hi =
    superblock.has64Bit && superblock.descriptorSize >= 0x2c ? view.getUint32(0x28, true) : 0;
  const inodeTableBlock = hi * 2 ** 32 + lo;

  if (inodeTableBlock === 0 || inodeTableBlock >= superblock.blockCount) {
    throw new Ext4FormatError(
      `group ${group} has an out-of-range inode table block ${inodeTableBlock}`,
    );
  }
  return { inodeTableBlock };
};
