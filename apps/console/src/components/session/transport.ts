/**
 * Shared browser-side plumbing for attaching to a session over the tunnel, used by both
 * legs: `components/terminal/terminal-session.tsx` (a PTY) and
 * `components/files/file-session.tsx` (a file helper).
 *
 * Lifted out of the terminal component rather than copied into the file one. The base64
 * helpers in particular exist specifically to avoid corrupting multi-byte content, and two
 * copies of that is exactly the kind of thing that drifts and then silently mangles one
 * side's payloads — the same reasoning `packages/session-token` records for extracting the
 * signature check rather than keeping a copy per app.
 */
import { BASE_URL } from "@/lib/api-client";

export type ConnectionState = "connecting" | "attached" | "closed" | "rejected";

/** Binary-safe base64 <-> bytes, matching `TunnelFrame`'s base64 payloads (the wire
 * protocol — see `packages/contracts/src/domains/tunnel.ts`). Plain `atob`/`btoa` on a raw
 * string would corrupt any multi-byte UTF-8 (box-drawing characters, unicode filenames,
 * file contents in any non-ASCII encoding) — going through bytes first keeps this correct. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` on a 64 KiB file chunk blows the argument
  // limit and throws. The terminal never hit this because keystrokes are tiny; file
  // transfers do, every time.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * `BASE_URL` is the control plane's http(s) origin (`@/lib/api-client`) — swap the scheme
 * for its websocket equivalent rather than hardcoding a second config value. The
 * BetterAuth session cookie rides along automatically (no credentials option exists on the
 * WebSocket constructor, unlike fetch) — console and control plane are same-SITE in every
 * deployment this build supports (differ only by port locally; a real deployment would
 * need matching registrable domains for this to keep working, same as every other
 * authenticated console call).
 *
 * `cols`/`rows` are meaningless for a file session and simply ignored server-side; the
 * route defaults them anyway. Kept in one signature rather than branching the URL builder,
 * since the attach route itself is shared and does not care which kind of session this is
 * — that is decided by the signed token the server replays, never by this request.
 */
export function attachUrl(sessionId: string, cols: number, rows: number): string {
  const wsBase = BASE_URL.replace(/^http/, "ws");
  return `${wsBase}/api/v1/access/sessions/${sessionId}/attach?cols=${cols}&rows=${rows}`;
}
