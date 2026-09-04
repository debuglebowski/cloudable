import type { TunnelFrame } from "@cloudable/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import { BASE_URL } from "@/lib/api-client";

import "@xterm/xterm/css/xterm.css";

export interface TerminalSessionProps {
  sessionId: string;
}

type ConnectionState = "connecting" | "attached" | "closed" | "rejected";

/** Binary-safe base64 <-> bytes, matching `TunnelFrame`'s `data` kind (the wire
 * protocol — see `packages/contracts/src/domains/tunnel.ts`). Plain `atob`/`btoa` on a raw
 * string would corrupt any multi-byte UTF-8 the shell emits (box-drawing characters, unicode
 * filenames, etc.) — going through bytes first keeps this correct. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function attachUrl(sessionId: string, cols: number, rows: number): string {
  // `BASE_URL` is the control plane's http(s) origin (`@/lib/api-client`) — swap the scheme
  // for its websocket equivalent rather than hardcoding a second config value. The
  // BetterAuth session cookie rides along automatically (no credentials option exists on the
  // WebSocket constructor, unlike fetch) — console and control plane are same-SITE in every
  // deployment this build supports (differ only by port locally; a real deployment would
  // need matching registrable domains for this to keep working, same as every other
  // authenticated console call).
  const wsBase = BASE_URL.replace(/^http/, "ws");
  return `${wsBase}/api/v1/access/sessions/${sessionId}/attach?cols=${cols}&rows=${rows}`;
}

/**
 * The browser leg of the web terminal: opens a websocket straight to
 * `http/handlers/tunnel.ts`'s `AccessAttachRouteLive`, which replays this session's
 * already-minted, already-persisted token to the tunnel daemon server-side — the browser
 * itself never sees or resends that token (see the token-handling reasoning in
 * `docs/agents.md` / the tunnel plan). Renders nothing until the daemon's own `attached`
 * frame arrives, matching that route's own comment: without waiting for it, there's no real
 * signal the PTY is ready other than data starting to arrive.
 */
export function TerminalSession({ sessionId }: TerminalSessionProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [closeReason, setCloseReason] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setState("connecting");
    setCloseReason(null);

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    const ws = new WebSocket(attachUrl(sessionId, term.cols, term.rows));

    const send = (frame: TunnelFrame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };

    ws.addEventListener("message", (event) => {
      let frame: TunnelFrame;
      try {
        frame = JSON.parse(event.data as string) as TunnelFrame;
      } catch {
        return;
      }
      switch (frame.kind) {
        case "attached":
          setState("attached");
          term.focus();
          break;
        case "attach_rejected":
          setState("rejected");
          setCloseReason(frame.reason);
          break;
        case "data":
          term.write(base64ToBytes(frame.dataBase64));
          break;
        case "close":
          setState("closed");
          setCloseReason(frame.reason);
          break;
        // "resize" only ever flows browser -> daemon in this build (the daemon has no
        // reason to resize the browser's terminal) — nothing to do on receipt.
        default:
          break;
      }
    });

    ws.addEventListener("close", () => {
      setState((prev) => (prev === "attached" ? "closed" : prev));
    });
    ws.addEventListener("error", () => {
      setState((prev) => (prev === "connecting" ? "closed" : prev));
    });

    const dataDisposable = term.onData((data) => {
      send({ kind: "data", sessionId, dataBase64: bytesToBase64(new TextEncoder().encode(data)) });
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      send({ kind: "resize", sessionId, cols, rows });
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(container);

    return () => {
      dataDisposable.dispose();
      resizeDisposable.dispose();
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [sessionId]);

  return (
    // flex-1 min-h-0: grows to fill whatever height the page wrapper actually
    // has instead of guessing a vh fraction (see session-terminal-page.tsx's
    // comment) — the status lines stay shrink-0 so only the terminal itself
    // consumes the extra space.
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {state === "connecting" && (
        <p className="shrink-0 text-sm text-muted-foreground">Connecting…</p>
      )}
      {state === "rejected" && (
        <p className="shrink-0 text-sm text-destructive">Connection rejected: {closeReason}</p>
      )}
      {state === "closed" && (
        <p className="shrink-0 text-sm text-muted-foreground">
          Session ended{closeReason ? `: ${closeReason}` : "."}
        </p>
      )}
      <div
        ref={containerRef}
        className="min-h-0 w-full flex-1 overflow-hidden rounded-lg bg-[#000] p-2"
      />
    </div>
  );
}
