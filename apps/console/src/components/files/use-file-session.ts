/**
 * The browser leg of a `method: "files"` session.
 *
 * Same shape as `components/terminal/terminal-session.tsx`: one websocket to the shared
 * attach route, which replays this session's already-minted, already-persisted token to the
 * tunnel daemon server-side — the browser never sees or resends that token. Renders nothing
 * until the daemon's `attached` frame arrives.
 *
 * What differs from the terminal is the traffic. A terminal is a byte stream in both
 * directions; this is request/response, so the hook keeps a pending map keyed by
 * `requestId` and hands each caller a promise. Downloads additionally accumulate `fs_chunk`
 * frames against that same id until one arrives with `final`.
 */
import { FS_CHUNK_BYTES, type FsOp, type FsResult, type TunnelFrame } from "@cloudable/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type ConnectionState,
  attachUrl,
  base64ToBytes,
  bytesToBase64,
} from "@/components/session/transport";

/** A settled operation, plus the bytes for a download. */
export interface FsOutcome {
  result: FsResult;
  /** Only for `op: "download"` — the reassembled file. */
  bytes?: Uint8Array;
}

interface Pending {
  resolve: (outcome: FsOutcome) => void;
  /** Download chunks, in arrival order. Empty for every other op. */
  chunks: Uint8Array[];
  /** Set once the result frame lands, so a download can settle on whichever comes last. */
  result: FsResult | null;
  /** Set once a chunk with `final` lands. */
  complete: boolean;
  isDownload: boolean;
}

export interface FileSession {
  state: ConnectionState;
  closeReason: string | null;
  /** Runs one operation. Rejects only if the socket is gone; a filesystem failure comes
   * back as `{ result: { ok: false, reason } }`, which callers render rather than throw. */
  run: (op: FsOp) => Promise<FsOutcome>;
  /** Uploads `bytes` to `path`, chunked. `replace` must be true to overwrite. */
  upload: (path: string, bytes: Uint8Array, replace: boolean) => Promise<FsOutcome>;
}

const SOCKET_CLOSED: FsResult = { ok: false, reason: "io_error" };

/** High-water mark for the upload send loop — a few chunks in flight, not a whole file. */
const MAX_BUFFERED_BYTES = 4 * FS_CHUNK_BYTES;

export function useFileSession(sessionId: string): FileSession {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [closeReason, setCloseReason] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, Pending>());
  const nextIdRef = useRef(0);

  useEffect(() => {
    const pending = pendingRef.current;
    // Size args are meaningless here and ignored server-side; the attach route is shared
    // with the terminal and does not branch on session kind.
    const ws = new WebSocket(attachUrl(sessionId, 80, 24));
    socketRef.current = ws;

    /** Settles everything still in flight as a failure. Callers render a failed result;
     * an unsettled promise is a leak they can never recover from. */
    const drainPending = () => {
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.resolve({ result: SOCKET_CLOSED });
      }
    };

    /** A download settles only once BOTH its result and its final chunk have arrived —
     * they race, and settling on the first would either lose the tail of the file or
     * report success before the bytes are in hand. */
    const settleIfDone = (requestId: string, entry: Pending) => {
      if (!entry.result) return;
      if (entry.isDownload && entry.result.ok && !entry.complete) return;
      pending.delete(requestId);
      if (!entry.isDownload || !entry.result.ok) {
        entry.resolve({ result: entry.result });
        return;
      }
      const total = entry.chunks.reduce((sum, c) => sum + c.length, 0);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of entry.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      entry.resolve({ result: entry.result, bytes });
    };

    ws.onmessage = (event) => {
      let frame: TunnelFrame;
      try {
        frame = JSON.parse(event.data as string) as TunnelFrame;
      } catch {
        return;
      }
      switch (frame.kind) {
        case "attached":
          setState("attached");
          break;
        case "attach_rejected":
          setState("rejected");
          setCloseReason(frame.reason);
          break;
        case "close":
          setCloseReason(frame.reason);
          setState((prev) => (prev === "attached" ? "closed" : prev));
          // The session is over, so nothing will answer what is still in flight. This has
          // to drain here and not only in `onclose`: when the helper exits on its own the
          // daemon sends `close`, and the control plane forwards it WITHOUT closing the
          // browser socket — so `onclose` may never fire and every pending promise would
          // hang unresolved, leaving the UI stuck on `busy` forever.
          drainPending();
          break;
        case "fs_response": {
          const entry = pending.get(frame.requestId);
          if (!entry) return;
          entry.result = frame.result;
          settleIfDone(frame.requestId, entry);
          break;
        }
        case "fs_chunk": {
          const entry = pending.get(frame.requestId);
          if (!entry) return;
          entry.chunks.push(base64ToBytes(frame.dataBase64));
          if (frame.final) entry.complete = true;
          settleIfDone(frame.requestId, entry);
          break;
        }
      }
    };

    ws.onclose = () => {
      setState((prev) => (prev === "rejected" ? prev : "closed"));
      drainPending();
    };
    ws.onerror = () => setState((prev) => (prev === "attached" ? "closed" : prev));

    return () => {
      ws.onclose = null;
      ws.close();
      socketRef.current = null;
      drainPending();
    };
  }, [sessionId]);

  const send = useCallback((frame: TunnelFrame): boolean => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }, []);

  /** Resolves once the socket's send queue is under the high-water mark, or false if it
   * died while we waited. */
  const waitForDrain = useCallback(async (): Promise<boolean> => {
    for (;;) {
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      if (ws.bufferedAmount <= MAX_BUFFERED_BYTES) return true;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }, []);

  const begin = useCallback((isDownload: boolean) => {
    const requestId = `r${nextIdRef.current++}`;
    let resolve!: (outcome: FsOutcome) => void;
    const promise = new Promise<FsOutcome>((r) => {
      resolve = r;
    });
    pendingRef.current.set(requestId, {
      resolve,
      chunks: [],
      result: null,
      complete: false,
      isDownload,
    });
    return { requestId, promise };
  }, []);

  const run = useCallback(
    (op: FsOp): Promise<FsOutcome> => {
      const { requestId, promise } = begin(op.op === "download");
      if (!send({ kind: "fs_request", sessionId, requestId, op })) {
        pendingRef.current.delete(requestId);
        return Promise.resolve({ result: SOCKET_CLOSED });
      }
      return promise;
    },
    [begin, send, sessionId],
  );

  const upload = useCallback(
    async (path: string, bytes: Uint8Array, replace: boolean): Promise<FsOutcome> => {
      const { requestId, promise } = begin(false);
      const op: FsOp = { op: "upload", path, sizeBytes: bytes.length, replace };
      if (!send({ kind: "fs_request", sessionId, requestId, op })) {
        pendingRef.current.delete(requestId);
        return { result: SOCKET_CLOSED };
      }

      // Chunks follow immediately rather than waiting for an ack. The helper opens its
      // handle synchronously on the request and rejects (`exists`, `too_large`) before
      // any chunk is applied, so a refused upload settles on that result and these
      // frames land on a session id the helper no longer has an upload for — dropped,
      // not written. Waiting for a round trip per chunk would make a 50 MiB upload take
      // 800 round trips.
      for (let offset = 0, seq = 0; offset < bytes.length; offset += FS_CHUNK_BYTES, seq++) {
        const slice = bytes.subarray(offset, offset + FS_CHUNK_BYTES);
        const final = offset + FS_CHUNK_BYTES >= bytes.length;
        if (
          !send({
            kind: "fs_chunk",
            sessionId,
            requestId,
            seq,
            dataBase64: bytesToBase64(slice),
            final,
          })
        ) {
          pendingRef.current.delete(requestId);
          return { result: SOCKET_CLOSED };
        }
        // Without this the whole file goes into `bufferedAmount` in one synchronous loop:
        // ~67 MiB of base64 for a 50 MiB upload, queued in the tab with nothing draining
        // it. Yielding while the socket is behind also lets the tab stay responsive.
        if (!(await waitForDrain())) {
          pendingRef.current.delete(requestId);
          return { result: SOCKET_CLOSED };
        }
      }

      // An empty file sends no chunks at all, so nothing would ever mark it final.
      if (bytes.length === 0) {
        send({ kind: "fs_chunk", sessionId, requestId, seq: 0, dataBase64: "", final: true });
      }

      return promise;
    },
    [begin, send, sessionId, waitForDrain],
  );

  return { state, closeReason, run, upload };
}
