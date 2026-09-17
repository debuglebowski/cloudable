// ---------------------------------------------------------------------------
// The ext4 superblock, and the geometry everything else needs from it.
//
// Field offsets follow the on-disk layout documented in the kernel's
// Documentation/filesystems/ext4/. They are stable — ext4's superblock is a
// public format and has only ever grown into reserved space — so the constants
// below are named rather than explained one by one.
//
// A machine's persistent disk is `mkfs.ext4` run on the RAW DEVICE, with no
// partition table (see `homeVolumeSection()` in
// `services/ProvisioningService.azure.ts`). So the superblock is at byte 1024
// of the image, with nothing to parse ahead of it. An OS disk WOULD have a GPT
// and is out of scope for that reason among others.
// ---------------------------------------------------------------------------
import type { RangeReader } from "../range-reader";

export class Ext4FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ext4FormatError";
  }
}

export const SUPERBLOCK_OFFSET = 1024;
const SUPERBLOCK_LENGTH = 1024;
const EXT4_MAGIC = 0xef53;

const INCOMPAT_FILETYPE = 0x0002;
const INCOMPAT_EXTENTS = 0x0040;
const INCOMPAT_64BIT = 0x0080;

export interface Superblock {
  blockSize: number;
  blocksPerGroup: number;
  inodesPerGroup: number;
  inodeSize: number;
  inodeCount: number;
  blockCount: number;
  /** Blocks not in use. `(blockCount - freeBlocks) * blockSize` is what `df` calls used —
   * the figure `snapshots.usedBytes` wants, available without asking an agent. */
  freeBlocks: number;
  firstDataBlock: number;
  /** 64 when the 64bit feature is on, else 32. */
  descriptorSize: number;
  has64Bit: boolean;
  hasExtents: boolean;
  /** When off, a dirent's `file_type` byte is part of `name_len` instead. */
  hasFiletype: boolean;
}

export const readSuperblock = async (reader: RangeReader): Promise<Superblock> => {
  const bytes = await reader.read(SUPERBLOCK_OFFSET, SUPERBLOCK_LENGTH);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint16(0x38, true);
  if (magic !== EXT4_MAGIC) {
    throw new Ext4FormatError(
      `not an ext4 filesystem: magic 0x${magic.toString(16)} at byte ${SUPERBLOCK_OFFSET}`,
    );
  }

  const logBlockSize = view.getUint32(0x18, true);
  if (logBlockSize > 6) {
    throw new Ext4FormatError(`implausible block size exponent ${logBlockSize}`);
  }
  const blockSize = 1024 << logBlockSize;

  const featureIncompat = view.getUint32(0x60, true);
  const has64Bit = (featureIncompat & INCOMPAT_64BIT) !== 0;

  // `s_desc_size` is only meaningful with the 64bit feature; without it the
  // descriptors are the historic 32 bytes whatever the field says.
  const declaredDescriptorSize = view.getUint16(0xfe, true);
  const descriptorSize = has64Bit ? declaredDescriptorSize || 64 : 32;

  const blocksPerGroup = view.getUint32(0x20, true);
  const inodesPerGroup = view.getUint32(0x28, true);
  if (blocksPerGroup === 0 || inodesPerGroup === 0) {
    throw new Ext4FormatError("superblock declares a zero-sized block or inode group");
  }

  // Pre-dynamic-revision filesystems have no `s_inode_size` and are always 128.
  const revision = view.getUint32(0x4c, true);
  const inodeSize = revision === 0 ? 128 : view.getUint16(0x58, true);
  if (inodeSize < 128 || inodeSize > blockSize) {
    throw new Ext4FormatError(`implausible inode size ${inodeSize}`);
  }

  const blockCountLo = view.getUint32(0x04, true);
  const blockCountHi = has64Bit ? view.getUint32(0x150, true) : 0;

  return {
    blockSize,
    blocksPerGroup,
    inodesPerGroup,
    inodeSize,
    inodeCount: view.getUint32(0x00, true),
    blockCount: blockCountHi * 2 ** 32 + blockCountLo,
    freeBlocks: (has64Bit ? view.getUint32(0x158, true) : 0) * 2 ** 32 + view.getUint32(0x0c, true),
    firstDataBlock: view.getUint32(0x14, true),
    descriptorSize,
    has64Bit,
    hasExtents: (featureIncompat & INCOMPAT_EXTENTS) !== 0,
    hasFiletype: (featureIncompat & INCOMPAT_FILETYPE) !== 0,
  };
};
