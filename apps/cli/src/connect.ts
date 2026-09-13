// ---------------------------------------------------------------------------
// `cloudable connect <machine>` — an interactive terminal on a machine, from
// a terminal.
//
// Same two legs the console's web terminal uses (`apps/console/src/components/
// terminal/terminal-session.tsx`): mint a session, then attach to it over a
// websocket that the control plane relays to the machine's tunnel daemon. No
// inbound port is involved anywhere (invariant 7) — the daemon's connection is
// outbound and already established; this rides it.
//
// The attach route runs the same session-cookie check as every other endpoint
// and rejects only a *wrong* `Origin`, so a CLI that sends none passes it
// (`http/handlers/tunnel.ts`). The session token is replayed server-side; it
// never touches this process.
//
// Ctrl-] detaches. Ctrl-C is the remote shell's, not ours — raw mode means
// every keystroke goes down the wire, which is the point.
// ---------------------------------------------------------------------------
import * as os from "node:os";
import { parseArgs, required } from "./args";
import { config } from "./config";
import { CliError, EXIT } from "./errors";
import { authenticatedApiRequest, postJson } from "./http-client";
import { currentIdentity } from "./identity";
import { machineId } from "./resolve";
import { requireSession } from "./session";

interface MintSessionResponse {
  sessionId: string;
  token: string;
  expiresAt: string;
}

/** Mirrors `TunnelFrame` in `@cloudable/contracts`, minus the frames only the daemon sends. */
type Frame =
  | { kind: "attached"; sessionId: string }
  | { kind: "attach_rejected"; sessionId: string; reason: string }
  | { kind: "data"; sessionId: string; dataBase64: string }
  | { kind: "close"; sessionId: string; reason: string };

const DETACH_KEY = 0x1d; // Ctrl-]
const ATTACH_TIMEOUT_MS = 15_000;

function terminalSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 };
}

function websocketUrl(sessionId: string, cols: number, rows: number): string {
  const base = config.apiUrl.replace(/^http/, "ws");
  return `${base}/api/v1/access/sessions/${sessionId}/attach?cols=${cols}&rows=${rows}`;
}

/** Bun's WebSocket takes headers; the DOM type does not admit it. */
type HeaderCapableWebSocket = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

function parseFrame(data: unknown): Frame | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (typeof parsed === "object" && parsed !== null && "kind" in parsed) return parsed as Frame;
  } catch {
    // A frame we cannot read is a frame we ignore — the session is still fine.
  }
  return undefined;
}

export async function runConnectCommand(argv: ReadonlyArray<string>): Promise<void> {
  const usage = "usage: cloudable connect <machine> [--os-user <user>]";
  const args = parseArgs(argv, { values: ["os-user"] });
  const target = required(args, 0, "a machine", usage);
  const osUser = args.flags["os-user"] ?? os.userInfo().username;

  const { orgId } = await currentIdentity();
  const id = await machineId(target);
  const session = requireSession();

  const minted = await authenticatedApiRequest<MintSessionResponse>(
    "/api/v1/access/sessions",
    postJson({ targetMachineId: id, targetOsUser: osUser, method: "terminal" }),
  );

  const { cols, rows } = terminalSize();
  const WebSocketWithHeaders = WebSocket as unknown as HeaderCapableWebSocket;
  const socket = new WebSocketWithHeaders(websocketUrl(minted.sessionId, cols, rows), {
    headers: { Cookie: session.cookie },
  });

  await new Promise<void>((resolve, reject) => {
    const raw = process.stdin.isTTY === true;
    let attached = false;
    let settled = false;

    const attachTimer = setTimeout(() => {
      if (!attached) {
        fail(
          new CliError(
            `the machine did not answer within ${ATTACH_TIMEOUT_MS / 1000}s.\n\nIts tunnel daemon may not be connected. Check \`cloudable machines get ${target}\`.`,
            EXIT.unreachable,
          ),
        );
      }
    }, ATTACH_TIMEOUT_MS);

    const onStdin = (chunk: Buffer) => {
      if (chunk.includes(DETACH_KEY)) {
        void detach();
        return;
      }
      socket.send(
        JSON.stringify({
          kind: "data",
          sessionId: minted.sessionId,
          dataBase64: chunk.toString("base64"),
        }),
      );
    };

    const onResize = () => {
      const size = terminalSize();
      socket.send(
        JSON.stringify({
          kind: "resize",
          sessionId: minted.sessionId,
          cols: size.cols,
          rows: size.rows,
        }),
      );
    };

    function restore(): void {
      clearTimeout(attachTimer);
      process.stdin.off("data", onStdin);
      process.stdout.off("resize", onResize);
      if (raw && process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    /** Every terminal path closes the socket: an open websocket keeps the
     * process alive long after the session is over. */
    function closeSocket(): void {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }

    function done(): void {
      if (settled) return;
      settled = true;
      restore();
      closeSocket();
      resolve();
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      restore();
      closeSocket();
      reject(error);
    }

    /** Our own exit: the PTY is still alive, so the session has to be ended. */
    async function detach(): Promise<void> {
      if (settled) return;
      settled = true;
      restore();
      closeSocket();
      try {
        await authenticatedApiRequest<{ ok: true }>(
          "/api/v1/access/sessions/end",
          postJson({ orgId, sessionId: minted.sessionId }),
        );
      } catch {
        // Detaching is not worth failing over; the session's own token expires.
      }
      console.log(`\nDetached from ${target}. Session ${minted.sessionId} ended.`);
      resolve();
    }

    socket.onmessage = (event: MessageEvent) => {
      const frame = parseFrame(event.data);
      if (!frame) return;

      if (frame.kind === "attached") {
        attached = true;
        clearTimeout(attachTimer);
        if (raw && process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", onStdin);
        process.stdout.on("resize", onResize);
        process.stderr.write(`Connected to ${target} as ${osUser}. Ctrl-] to detach.\r\n`);
        return;
      }
      if (frame.kind === "attach_rejected") {
        fail(new CliError(`the machine refused the session: ${frame.reason}`, EXIT.denied));
        return;
      }
      if (frame.kind === "data") {
        process.stdout.write(Buffer.from(frame.dataBase64, "base64"));
        return;
      }
      if (frame.kind === "close") {
        restore();
        process.stderr.write(`\r\nSession closed: ${frame.reason}\r\n`);
        done();
      }
    };

    socket.onerror = () => {
      fail(
        new CliError(
          `could not attach to session ${minted.sessionId}.\n\nThe machine must be running and its tunnel daemon connected.`,
          EXIT.unreachable,
        ),
      );
    };

    socket.onclose = (event: CloseEvent) => {
      if (settled) return;
      if (attached) {
        restore();
        process.stderr.write(`\r\nDisconnected (${event.code}).\r\n`);
        done();
        return;
      }
      fail(
        new CliError(
          `the control plane closed the connection before attaching (${event.code}${event.reason ? `: ${event.reason}` : ""}).`,
          EXIT.failure,
        ),
      );
    };
  });
}
