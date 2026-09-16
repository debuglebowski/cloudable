import type { ConnectionState } from "@/components/session/transport";
import { ApiError, apiGet, apiPost } from "@/lib/api-client";
// ---------------------------------------------------------------------------
// The snapshot half of the file browser's transport.
//
// `useFileSession` next door opens a websocket to a tunnel daemon on a live
// machine. There is no daemon here and no machine — the control plane reads the
// disk snapshot itself — so this is plain HTTP, one request per operation.
//
// It satisfies the same `FileSession` shape on purpose, so `FileBrowser` can be
// pointed at either without knowing which. The differences show up as honest
// refusals rather than as a different component: `upload` cannot succeed
// because a snapshot has no write path at all, so it returns the same
// `{ ok: false }` shape a live machine would use for a refused write, and the
// browser renders it the way it renders any other failure.
// ---------------------------------------------------------------------------
import type { FsOp, FsResult } from "@cloudable/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileSession, FsOutcome } from "./use-file-session";

/** A snapshot is immutable, so anything that would change it is refused here rather than
 * sent. `io_error` is the closest reason in the shared vocabulary — the browser hides
 * these controls in `readOnly` mode anyway, and this is the backstop. */
const READ_ONLY: FsResult = { ok: false, reason: "io_error" };

const failureFor = (error: unknown): FsResult => {
  if (error instanceof ApiError) {
    // 403 is a lapsed elevation or a policy change since the session opened — the gate
    // runs on every operation, not just at open, so this is a live answer.
    if (error.status === 403) return { ok: false, reason: "permission_denied" };
    if (error.status === 404) return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: "io_error" };
};

export function useSnapshotInspection(sessionId: string): FileSession {
  const [state, setState] = useState<ConnectionState>("connecting");
  const [closeReason, setCloseReason] = useState<string | null>(null);

  // There is no socket to attach, so the session is usable from the moment it exists.
  // Settled once rather than probed: the browser's own first listing is the real check,
  // and a probe here would just be a second request saying the same thing.
  useEffect(() => {
    setState("attached");
    setCloseReason(null);
  }, []);

  const run = useCallback(
    async (op: FsOp): Promise<FsOutcome> => {
      if (op.op !== "list" && op.op !== "read") {
        return { result: READ_ONLY };
      }
      try {
        const query = `?path=${encodeURIComponent(op.path)}`;
        const result = await apiGet<FsResult>(
          `/api/v1/archive/inspections/${sessionId}/${op.op}${query}`,
        );
        return { result };
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          // The session is gone or no longer authorized. Surfacing it as a closed
          // connection is what the browser already knows how to render, and it is
          // accurate: nothing further will work.
          setState("closed");
          setCloseReason(
            error.status === 403
              ? "Your access to this snapshot was withdrawn."
              : "This inspection session has ended.",
          );
        }
        return { result: failureFor(error) };
      }
    },
    [sessionId],
  );

  const upload = useCallback(async (): Promise<FsOutcome> => ({ result: READ_ONLY }), []);

  // Ends the session when the page goes away, so the control plane can revoke the
  // provider grant rather than waiting for the TTL. Best-effort: a closed tab cannot be
  // relied on to finish a request, which is why the server also expires sessions on its
  // own.
  useEffect(() => {
    return () => {
      void apiPost(`/api/v1/archive/inspections/${sessionId}/end`).catch(() => {});
    };
  }, [sessionId]);

  return useMemo(() => ({ state, closeReason, run, upload }), [state, closeReason, run, upload]);
}
