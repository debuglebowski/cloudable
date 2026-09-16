// ---------------------------------------------------------------------------
// Byte access to a disk image, and the one seam that keeps the ext4 reader
// provider-agnostic.
//
// Everything above this reads a filesystem; everything below it fetches bytes.
// In production those bytes come over HTTPS from a time-limited SAS URL that
// `ProvisioningService.grantSnapshotRead` obtained; in tests they come from a
// local file. Neither the reader nor its tests know which.
// ---------------------------------------------------------------------------
import { open } from "node:fs/promises";

export class RangeReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RangeReadError";
  }
}

export interface RangeReader {
  /** Total addressable bytes. */
  size(): Promise<number>;
  /**
   * Exactly `length` bytes starting at `offset`.
   *
   * Short reads are an error, never a silently truncated buffer: a filesystem
   * parser handed fewer bytes than it asked for reads whatever follows in its own
   * buffer as structure, and produces confident nonsense rather than failing.
   */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Reads from a local image. Used by tests and by the fake provider. */
export const fileRangeReader = async (path: string): Promise<RangeReader> => {
  const handle = await open(path, "r");
  const stat = await handle.stat();
  return {
    size: async () => stat.size,
    read: async (offset, length) => {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new RangeReadError(`short read at ${offset}: wanted ${length}, got ${bytesRead}`);
      }
      return buffer;
    },
  };
};

/**
 * Reads over HTTP using `Range` headers — how a snapshot is actually read in
 * production.
 *
 * Azure returns the disk image as a page blob whose byte 0 is the disk's byte 0, so
 * offsets need no translation. A server that ignores `Range` and returns `200` with the
 * whole body is a hard failure rather than something to paper over: silently accepting it
 * would download the entire disk to satisfy a 4 KiB request.
 */
export const httpRangeReader = (url: string, fetchImpl: typeof fetch = fetch): RangeReader => {
  let cachedSize: number | undefined;

  return {
    size: async () => {
      if (cachedSize !== undefined) return cachedSize;
      const response = await fetchImpl(url, { method: "HEAD" });
      if (!response.ok) {
        throw new RangeReadError(`HEAD failed: ${response.status}`);
      }
      const length = Number(response.headers.get("content-length"));
      if (!Number.isFinite(length) || length <= 0) {
        throw new RangeReadError("HEAD returned no usable content-length");
      }
      cachedSize = length;
      return length;
    },
    read: async (offset, length) => {
      const end = offset + length - 1;
      const response = await fetchImpl(url, { headers: { range: `bytes=${offset}-${end}` } });
      if (response.status !== 206) {
        throw new RangeReadError(
          response.status === 200
            ? "server ignored the Range header and returned the whole blob"
            : `range read failed: ${response.status}`,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== length) {
        throw new RangeReadError(
          `short range read at ${offset}: wanted ${length}, got ${bytes.byteLength}`,
        );
      }
      return bytes;
    },
  };
};

/**
 * Block-aligned cache in front of another reader.
 *
 * Not an optimisation so much as a correctness-of-cost measure. Walking a directory
 * touches the superblock, a group descriptor, an inode, then an extent tree — several
 * small reads landing inside the same few blocks. Uncached, each is its own HTTPS round
 * trip to blob storage, and listing one directory would cost dozens.
 *
 * Deliberately per-session and bounded: a snapshot is immutable for the life of a grant,
 * so nothing here can go stale, but a session browsing a large tree must not hold the
 * whole disk in memory.
 */
export const cachingReader = (
  inner: RangeReader,
  options: { blockSize?: number; maxBlocks?: number } = {},
): RangeReader => {
  const blockSize = options.blockSize ?? 64 * 1024;
  const maxBlocks = options.maxBlocks ?? 256;
  const blocks = new Map<number, Uint8Array>();

  const blockAt = async (index: number): Promise<Uint8Array> => {
    const cached = blocks.get(index);
    if (cached) {
      // Re-insert so iteration order stays least-recently-used.
      blocks.delete(index);
      blocks.set(index, cached);
      return cached;
    }

    const offset = index * blockSize;
    const total = await inner.size();
    const length = Math.min(blockSize, total - offset);
    if (length <= 0) throw new RangeReadError(`block ${index} is past the end of the image`);

    const bytes = await inner.read(offset, length);
    blocks.set(index, bytes);
    if (blocks.size > maxBlocks) {
      const oldest = blocks.keys().next();
      if (!oldest.done) blocks.delete(oldest.value);
    }
    return bytes;
  };

  return {
    size: () => inner.size(),
    read: async (offset, length) => {
      const out = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        const absolute = offset + written;
        const index = Math.floor(absolute / blockSize);
        const within = absolute - index * blockSize;
        const block = await blockAt(index);
        const take = Math.min(length - written, block.byteLength - within);
        if (take <= 0) {
          throw new RangeReadError(`short read at ${offset}: image ends at ${absolute}`);
        }
        out.set(block.subarray(within, within + take), written);
        written += take;
      }
      return out;
    },
  };
};
