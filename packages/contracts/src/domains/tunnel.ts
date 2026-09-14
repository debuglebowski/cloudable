/**
 * Wire types for the tunnel daemon's relay protocol — the
 * one shared envelope both legs of the relay speak:
 *
 *   browser <--wss--> control plane <--wss--> tunnel daemon (on the VM)
 *
 * JSON + base64 data, not raw binary frames — matches every other wire
 * protocol in this repo (events, REST bodies, the session token's own
 * claims segment), and terminal traffic is small enough that the ~33%
 * base64 overhead is immaterial. See `apps/control-plane/src/http/handlers/tunnel.ts`
 * (control plane's two websocket routes) and `apps/tunnel-daemon/src/connection.ts`
 * (daemon's outbound connection) for where this type is actually read/written
 * on the wire.
 */
export type TunnelFrame =
  /** Browser -> control plane -> daemon: "start (or resume) this session." `sessionToken` is
   * the signed token from `MintSessionTokenResponse`, replayed server-side on attach — the
   * browser never resupplies it directly (see the plan's "Token handling decision"). */
  | { kind: "attach"; sessionId: string; sessionToken: string; cols: number; rows: number }
  /** Daemon -> control plane -> browser: the session token verified and the session is
   * live — a PTY for `method: "terminal"`, a file-browsing helper for `method: "files"`.
   * Which one is decided by the token's own `method` claim, never by the `attach` frame. */
  | { kind: "attached"; sessionId: string }
  /** Daemon -> control plane -> browser: the session token failed verification
   * ("validate the signature on every session, including under load") — nothing was spawned. */
  | { kind: "attach_rejected"; sessionId: string; reason: string }
  /** Either direction: raw terminal bytes, base64-encoded. */
  | { kind: "data"; sessionId: string; dataBase64: string }
  /** Browser -> control plane -> daemon: the browser's terminal was resized. */
  | { kind: "resize"; sessionId: string; cols: number; rows: number }
  /** Either direction: this session is over. From the control plane: a person ended it, a
   * policy/elevation change revoked it, or the daemon connection carrying it dropped. From the
   * daemon: the PTY's child process exited on its own. */
  | { kind: "close"; sessionId: string; reason: string }
  /** Browser -> control plane -> daemon: one filesystem operation on a `method: "files"`
   * session. `requestId` correlates the reply; `sessionId` remains the session-level key
   * both `isTunnelFrame` guards require. */
  | { kind: "fs_request"; sessionId: string; requestId: string; op: FsOp }
  /** Daemon -> control plane -> browser: the outcome of one `fs_request`. For
   * `op: "download"` a successful result is followed by `fs_chunk` frames carrying the
   * bytes; for every other op the result is complete on its own. */
  | { kind: "fs_response"; sessionId: string; requestId: string; result: FsResult }
  /** Either direction: one slice of a file body, `FS_CHUNK_BYTES` at most. Daemon -> browser
   * for a download, browser -> daemon for an upload. `seq` starts at 0 and increments; the
   * receiver rejects an out-of-order chunk rather than silently corrupting the file. */
  | {
      kind: "fs_chunk";
      sessionId: string;
      requestId: string;
      seq: number;
      dataBase64: string;
      final: boolean;
    };

// ---------------------------------------------------------------------------
// Filesystem operations for `method: "files"` sessions.
//
// Every operation runs in an unprivileged helper process on the machine,
// dropped to the session's own OS user (`apps/tunnel-daemon/src/files-session.ts`),
// so the OS permission model is the only boundary — exactly as it is for a
// shell. There is deliberately no path allowlist and no chroot: file recovery
// legitimately reaches `/etc` and `/var/log`, and a restriction the terminal
// doesn't share would be theatre rather than security.
//
// Deliberately absent: delete and chmod. Neither is needed to recover or fix a
// file, and both are easy to fire by accident through a pointer interface.
// ---------------------------------------------------------------------------

/** Read-and-edit ceiling. A file larger than this is still downloadable, just not
 * openable in the editor — holding it as a base64 string in a browser tab is the
 * constraint, not anything about the file. */
export const FS_MAX_INLINE_BYTES = 1024 * 1024;

/** Download/upload ceiling. */
export const FS_MAX_TRANSFER_BYTES = 50 * 1024 * 1024;

/** Bytes per `fs_chunk` frame, before base64 expands them by ~33%. */
export const FS_CHUNK_BYTES = 64 * 1024;

/** Directory listings stop here and set `truncated`, rather than serialising an
 * unbounded directory into one websocket frame. */
export const FS_MAX_ENTRIES = 10_000;

export type FsEntryType = "file" | "directory" | "symlink" | "other";

export interface FsEntry {
  name: string;
  type: FsEntryType;
  sizeBytes: number;
  /** ISO 8601. */
  modifiedAt: string;
  /** `ls`-style permission triplet, e.g. `"rw-r--r--"`. Display only — it cannot be
   * edited from here, and the real check is the OS's when an operation runs. */
  mode: string;
  /** Set only when `type` is `"symlink"`. Symlinks are shown as themselves rather than
   * silently resolved, so what's on disk stays legible; navigating one follows it. */
  symlinkTarget: string | null;
}

export type FsOp =
  | { op: "list"; path: string }
  | { op: "read"; path: string }
  /** `expectedModifiedAt` is the `modifiedAt` the editor last saw. A mismatch means
   * someone else changed the file underneath this session, and the write is refused
   * with `changed_on_disk` rather than silently discarding their work. Null skips the
   * check, for a file being created rather than edited. */
  | { op: "write"; path: string; contentBase64: string; expectedModifiedAt: string | null }
  | { op: "mkdir"; path: string }
  | { op: "rename"; from: string; to: string }
  | { op: "download"; path: string }
  /** Followed by `fs_chunk` frames. `replace` must be explicitly true to overwrite an
   * existing file; without it an existing path fails with `exists`. There is no delete
   * operation, so a silent overwrite would be the one unrecoverable action in this
   * interface. */
  | { op: "upload"; path: string; sizeBytes: number; replace: boolean };

export type FsFailureReason =
  | "not_found"
  | "permission_denied"
  | "not_a_directory"
  | "is_a_directory"
  | "too_large"
  | "is_binary"
  | "exists"
  | "changed_on_disk"
  | "invalid_path"
  | "io_error";

/**
 * Discriminated on `ok` first, then `op`. Failures carry a fixed reason code and never
 * the raw OS error string — the same rule `AttestationError` follows, for the same
 * reason: errno text can echo paths and internals into logs and UI.
 */
export type FsResult =
  | { ok: false; reason: FsFailureReason }
  | {
      ok: true;
      op: "list";
      path: string;
      /** Null at `/`. */
      parent: string | null;
      entries: ReadonlyArray<FsEntry>;
      truncated: boolean;
    }
  | {
      ok: true;
      op: "read";
      path: string;
      contentBase64: string;
      modifiedAt: string;
      sizeBytes: number;
    }
  | { ok: true; op: "write"; path: string; modifiedAt: string; sizeBytes: number }
  | { ok: true; op: "mkdir"; path: string }
  | { ok: true; op: "rename"; from: string; to: string }
  /** Success here means the stream is starting, not that it finished — `fs_chunk` frames
   * with the same `requestId` follow, the last carrying `final: true`. */
  | { ok: true; op: "download"; path: string; sizeBytes: number }
  /** Sent once the final uploaded chunk is durably written. */
  | { ok: true; op: "upload"; path: string };

// `GET /api/v1/tunnel/session-token-key`'s response reuses `access.ts`'s
// existing `SessionTokenPublicKeyResponse` (same concept: the session-token
// signer's public key, `keyId` + base64 SPKI-DER-encoded Ed25519 key) rather
// than a second, differently-shaped copy — see that file for the full doc
// comment.
