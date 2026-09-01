/**
 * Wire types for the tunnel daemon's relay protocol (spec §8.2/§11.1) — the
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
  /** Daemon -> control plane -> browser: the session token verified, a PTY is live. */
  | { kind: "attached"; sessionId: string }
  /** Daemon -> control plane -> browser: the session token failed verification (spec §11.1's
   * "validate the signature on every session, including under load") — nothing was spawned. */
  | { kind: "attach_rejected"; sessionId: string; reason: string }
  /** Either direction: raw terminal bytes, base64-encoded. */
  | { kind: "data"; sessionId: string; dataBase64: string }
  /** Browser -> control plane -> daemon: the browser's terminal was resized. */
  | { kind: "resize"; sessionId: string; cols: number; rows: number }
  /** Either direction: this session is over. From the control plane: a person ended it, a
   * policy/elevation change revoked it, or the daemon connection carrying it dropped. From the
   * daemon: the PTY's child process exited on its own. */
  | { kind: "close"; sessionId: string; reason: string };

// `GET /api/v1/tunnel/session-token-key`'s response reuses `access.ts`'s
// existing `SessionTokenPublicKeyResponse` (same concept: the session-token
// signer's public key, `keyId` + base64 SPKI-DER-encoded Ed25519 key) rather
// than a second, differently-shaped copy — see that file for the full doc
// comment.
