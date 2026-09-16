// Hand-built extent trees, for the shapes `mkfs.ext4` will not reliably produce on a
// small fixture: an interior node, an uninitialised extent, and a hole. All three are
// silent when read wrong — a wrong answer, not an error — so they are worth constructing
// deliberately rather than hoping the fixture happens to contain one.
import { describe, expect, test } from "bun:test";
import type { RangeReader } from "../range-reader";
import { readExtents, readFileRange } from "./extents";
import type { Superblock } from "./superblock";

const BLOCK_SIZE = 1024;

const superblock: Superblock = {
  blockSize: BLOCK_SIZE,
  blocksPerGroup: 8192,
  inodesPerGroup: 256,
  inodeSize: 256,
  inodeCount: 4096,
  blockCount: 4096,
  firstDataBlock: 1,
  descriptorSize: 64,
  has64Bit: true,
  hasExtents: true,
  hasFiletype: true,
};

/** A disk of `blockCount` blocks, where block N is filled with the byte N unless
 * `overrides` says otherwise. Lets a test assert which physical block it actually read. */
const diskOf = (overrides: Map<number, Uint8Array> = new Map()): RangeReader => {
  const total = superblock.blockCount * BLOCK_SIZE;
  return {
    size: async () => total,
    read: async (offset, length) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        const absolute = offset + i;
        const block = Math.floor(absolute / BLOCK_SIZE);
        const override = overrides.get(block);
        out[i] = override ? (override[absolute % BLOCK_SIZE] ?? 0) : block & 0xff;
      }
      return out;
    },
  };
};

const header = (into: DataView, at: number, entries: number, depth: number) => {
  into.setUint16(at + 0, 0xf30a, true);
  into.setUint16(at + 2, entries, true);
  into.setUint16(at + 4, 4, true);
  into.setUint16(at + 6, depth, true);
};

const extent = (into: DataView, at: number, logical: number, physical: number, length: number) => {
  into.setUint32(at + 0, logical, true);
  into.setUint16(at + 4, length, true);
  into.setUint16(at + 6, 0, true);
  into.setUint32(at + 8, physical, true);
};

const index = (into: DataView, at: number, logical: number, child: number) => {
  into.setUint32(at + 0, logical, true);
  into.setUint32(at + 4, child, true);
  into.setUint16(at + 8, 0, true);
};

describe("extent trees", () => {
  test("reads extents stored inline in the inode", async () => {
    const iBlock = new Uint8Array(60);
    const view = new DataView(iBlock.buffer);
    header(view, 0, 2, 0);
    extent(view, 12, 0, 100, 2);
    extent(view, 24, 2, 200, 1);

    expect(await readExtents(diskOf(), superblock, iBlock)).toEqual([
      { logicalBlock: 0, physicalBlock: 100, blockCount: 2, uninitialised: false },
      { logicalBlock: 2, physicalBlock: 200, blockCount: 1, uninitialised: false },
    ]);
  });

  test("descends through an interior node", async () => {
    const leaf = new Uint8Array(BLOCK_SIZE);
    const leafView = new DataView(leaf.buffer);
    header(leafView, 0, 2, 0);
    extent(leafView, 12, 0, 300, 1);
    extent(leafView, 24, 1, 301, 1);

    const iBlock = new Uint8Array(60);
    const rootView = new DataView(iBlock.buffer);
    header(rootView, 0, 1, 1);
    index(rootView, 12, 0, 50);

    const extents = await readExtents(diskOf(new Map([[50, leaf]])), superblock, iBlock);
    expect(extents).toEqual([
      { logicalBlock: 0, physicalBlock: 300, blockCount: 1, uninitialised: false },
      { logicalBlock: 1, physicalBlock: 301, blockCount: 1, uninitialised: false },
    ]);
  });

  test("an extent longer than 32768 is uninitialised, and its real length is the remainder", async () => {
    const iBlock = new Uint8Array(60);
    const view = new DataView(iBlock.buffer);
    header(view, 0, 1, 0);
    extent(view, 12, 0, 400, 32768 + 3);

    expect(await readExtents(diskOf(), superblock, iBlock)).toEqual([
      { logicalBlock: 0, physicalBlock: 400, blockCount: 3, uninitialised: true },
    ]);
  });

  test("refuses a node claiming more entries than it can hold", async () => {
    const iBlock = new Uint8Array(60);
    const view = new DataView(iBlock.buffer);
    header(view, 0, 99, 0);
    expect(readExtents(diskOf(), superblock, iBlock)).rejects.toThrow(/at most/);
  });

  test("refuses a tree that points at itself", async () => {
    const loop = new Uint8Array(BLOCK_SIZE);
    const loopView = new DataView(loop.buffer);
    header(loopView, 0, 1, 1);
    index(loopView, 12, 0, 50);

    const iBlock = new Uint8Array(60);
    const rootView = new DataView(iBlock.buffer);
    header(rootView, 0, 1, 1);
    index(rootView, 12, 0, 50);

    expect(readExtents(diskOf(new Map([[50, loop]])), superblock, iBlock)).rejects.toThrow(/cycle/);
  });

  test("rejects a node with the wrong magic rather than reading noise as structure", async () => {
    expect(readExtents(diskOf(), superblock, new Uint8Array(60))).rejects.toThrow(/magic/);
  });
});

describe("reading file contents", () => {
  test("a hole reads as zeroes, not as whatever is on the disk", async () => {
    // Logical block 1 is covered by nothing. The underlying disk has non-zero bytes
    // everywhere, so a reader that fell through to it would return block 101's contents.
    const extents = [
      { logicalBlock: 0, physicalBlock: 100, blockCount: 1, uninitialised: false },
      { logicalBlock: 2, physicalBlock: 102, blockCount: 1, uninitialised: false },
    ];
    const bytes = await readFileRange(diskOf(), superblock, extents, 0, BLOCK_SIZE * 3);

    expect(bytes[0]).toBe(100);
    expect(bytes[BLOCK_SIZE]).toBe(0);
    expect(bytes[BLOCK_SIZE * 2]).toBe(102);
  });

  test("an uninitialised extent reads as zeroes, never as stale disk contents", async () => {
    // This is a data-leak guard, not a correctness nicety: those blocks are allocated
    // but never written, so whatever is in them belonged to something else.
    const extents = [{ logicalBlock: 0, physicalBlock: 100, blockCount: 1, uninitialised: true }];
    const bytes = await readFileRange(diskOf(), superblock, extents, 0, BLOCK_SIZE);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  test("reads a range that starts and ends mid-block", async () => {
    const extents = [{ logicalBlock: 0, physicalBlock: 100, blockCount: 3, uninitialised: false }];
    const bytes = await readFileRange(diskOf(), superblock, extents, BLOCK_SIZE - 2, 4);
    expect(Array.from(bytes)).toEqual([100, 100, 101, 101]);
  });
});
