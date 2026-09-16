import { describe, expect, test } from "bun:test";
import { RangeReadError, cachingReader, httpRangeReader } from "./range-reader";

const bodyOf = (bytes: Uint8Array, status = 206) =>
  new Response(bytes.buffer as ArrayBuffer, {
    status,
    headers: { "content-length": String(bytes.byteLength) },
  });

/** `typeof fetch` has overloads a bare thunk does not structurally satisfy, so the cast
 * goes through `unknown` rather than being widened at each call site. */
const stubFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch =>
  impl as unknown as typeof fetch;

describe("httpRangeReader", () => {
  test("asks for the range it wants and returns exactly it", async () => {
    const seen: string[] = [];
    const reader = httpRangeReader(
      "https://example.test/disk",
      stubFetch(async (_url, init) => {
        seen.push(String((init?.headers as Record<string, string>).range));
        return bodyOf(new Uint8Array([1, 2, 3, 4]));
      }),
    );

    expect(Array.from(await reader.read(1024, 4))).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual(["bytes=1024-1027"]);
  });

  test("a server that ignores Range is an error, not a slow success", async () => {
    // Accepting a 200 here would download the whole disk to satisfy a 4 KiB read,
    // and would keep working well enough that nobody noticed until the bill.
    const reader = httpRangeReader(
      "https://example.test/disk",
      stubFetch(async () => bodyOf(new Uint8Array(64 * 1024 * 1024), 200)),
    );

    expect(reader.read(0, 4)).rejects.toThrow(/ignored the Range header/);
  });

  test("a short range read fails rather than returning a padded buffer", async () => {
    const reader = httpRangeReader(
      "https://example.test/disk",
      stubFetch(async () => bodyOf(new Uint8Array([1, 2]))),
    );

    expect(reader.read(0, 4)).rejects.toThrow(RangeReadError);
  });
});

describe("cachingReader", () => {
  const countingDisk = () => {
    const state = { reads: 0 };
    const total = 1024 * 16;
    return {
      state,
      reader: {
        size: async () => total,
        read: async (offset: number, length: number) => {
          state.reads++;
          const out = new Uint8Array(length);
          for (let i = 0; i < length; i++) out[i] = (offset + i) & 0xff;
          return out;
        },
      },
    };
  };

  test("serves repeat reads of the same block without going back to the disk", async () => {
    const { state, reader } = countingDisk();
    const cached = cachingReader(reader, { blockSize: 4096 });

    await cached.read(0, 16);
    await cached.read(32, 16);
    expect(state.reads).toBe(1);
  });

  test("stitches a read that spans blocks", async () => {
    const { reader } = countingDisk();
    const cached = cachingReader(reader, { blockSize: 1024 });

    const bytes = await cached.read(1022, 4);
    expect(Array.from(bytes)).toEqual([1022 & 0xff, 1023 & 0xff, 1024 & 0xff, 1025 & 0xff]);
  });

  test("evicts rather than growing without bound", async () => {
    const { state, reader } = countingDisk();
    const cached = cachingReader(reader, { blockSize: 1024, maxBlocks: 2 });

    await cached.read(0, 1);
    await cached.read(1024, 1);
    await cached.read(2048, 1);
    // Block 0 was evicted by the third, so re-reading it costs another disk read.
    await cached.read(0, 1);
    expect(state.reads).toBe(4);
  });

  test("reading past the end of the image fails", async () => {
    const { reader } = countingDisk();
    const cached = cachingReader(reader, { blockSize: 1024 });
    expect(cached.read(1024 * 16, 8)).rejects.toThrow(RangeReadError);
  });
});
