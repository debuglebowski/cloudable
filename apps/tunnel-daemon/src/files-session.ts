// ---------------------------------------------------------------------------
// The privileged half of a `method: "files"` session: spawns the unprivileged
// helper (`fs-helper.ts`) under the session's OS user and shuttles messages
// between it and the websocket.
//
// Peer to `pty.ts`, and deliberately shaped like it — one child process per
// session, `su` for the privilege drop, a `kill()` that policy-triggered
// termination can call without depending on anything inside the session
// behaving. If you are changing one of these two files, check whether the other
// needs the same change.
//
// The privilege drop is the point; see `fs-helper.ts`'s header for why a
// root-side implementation would invert the two elevation levels.
//
// Re-execs THIS binary rather than shipping a second one. `bun build --compile`
// produces a single executable installed at one path, and `process.execPath`
// inside it is that executable, so `<self> --fs-helper` needs no new build
// target, no second artifact to install, and no way for the two halves to be at
// different versions on the same machine.
// ---------------------------------------------------------------------------
import type { FsOp, FsResult } from "@cloudable/contracts";
import type { HelperMessage, HelperRequest } from "./fs-helper";
import { InvalidOsUserError, isValidOsUsername } from "./pty";

export interface FilesSessionCallbacks {
  /** A terminal result for one request. Forwarded as an `fs_response` frame. */
  onResult: (requestId: string, result: FsResult) => void;
  /** One slice of a download. Forwarded as an `fs_chunk` frame. */
  onChunk: (requestId: string, chunk: { seq: number; dataBase64: string; final: boolean }) => void;
  /** The helper process ended. Treated exactly like a PTY exiting. */
  onExit: (info: { exitCode: number | null; signalCode: string | null }) => void;
}

export interface SpawnFilesSessionOptions extends FilesSessionCallbacks {
  targetOsUser: string;
  /**
   * Test-only escape hatch, same contract as `pty.ts`'s: run this instead of
   * `su - <targetOsUser> -c '<self> --fs-helper'`. Never set in production —
   * dropping privilege IS the real path, and a test double cannot exercise it
   * unprivileged.
   */
  commandOverride?: ReadonlyArray<string>;
}

export interface FilesSession {
  request(requestId: string, op: FsOp): void;
  /** One slice of an upload, from the browser. */
  chunk(requestId: string, chunk: { seq: number; dataBase64: string; final: boolean }): void;
  kill(): void;
}

/**
 * The argv that drops into `targetOsUser` and re-execs this binary as the helper.
 *
 * Exported so it can be asserted directly. `spawnFilesSession`'s own tests can only
 * exercise the rejection path without a real `su` and root, so this is the one place
 * the accepted shape is checked — the same split `pty.ts` uses for `isValidOsUsername`.
 *
 * `su -c` hands its argument to a shell, so `selfPath` is single-quoted. The username
 * is a separate argv element and never reaches that shell, but it is still validated
 * by the caller before we get here: a value like `-c` would be parsed by some `su`
 * implementations as an OPTION rather than a username, running a command as root
 * instead of dropping to anybody. That is a real escalation, and `pty.ts` documents it
 * at length — the same check guards the same vector here.
 */
export function fsHelperCommand(targetOsUser: string, selfPath: string): string[] {
  return ["su", "-", targetOsUser, "-c", `'${selfPath.replace(/'/g, "'\\''")}' --fs-helper`];
}

/**
 * Spawns a file session.
 *
 * @throws {InvalidOsUserError} if `targetOsUser` doesn't look like a real OS username and
 * no `commandOverride` was given. Thrown before any process is created.
 */
export function spawnFilesSession(options: SpawnFilesSessionOptions): FilesSession {
  if (!options.commandOverride && !isValidOsUsername(options.targetOsUser)) {
    throw new InvalidOsUserError(options.targetOsUser);
  }

  const command =
    options.commandOverride ?? fsHelperCommand(options.targetOsUser, process.execPath);
  const proc = Bun.spawn([...command], {
    stdin: "pipe",
    stdout: "pipe",
    // Inherited, not piped: the helper writes only its protocol to stdout, and anything
    // on stderr is a crash we want in the daemon's own log rather than silently filling
    // an unread pipe buffer until the child blocks on write.
    stderr: "inherit",
  });

  const send = (request: HelperRequest) => {
    // A dead helper is not an error worth crashing the daemon over. The session is
    // already finished from the browser's point of view, and `onExit` will have closed
    // it; a request racing that teardown simply has nowhere to go.
    try {
      proc.stdin.write(`${JSON.stringify(request)}\n`);
      proc.stdin.flush();
    } catch {}
  };

  void (async () => {
    // Line-buffered reassembly. A chunk message is ~88 KiB of base64 and will not
    // arrive in one read, so partial lines have to be carried across reads — splitting
    // on whatever a single read happened to contain would corrupt every large transfer.
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const bytes of proc.stdout) {
      buffered += decoder.decode(bytes, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (line.length === 0) continue;
        let message: HelperMessage;
        try {
          message = JSON.parse(line) as HelperMessage;
        } catch {
          continue;
        }
        if (typeof message?.id !== "string") continue;
        if ("result" in message) options.onResult(message.id, message.result);
        else if ("chunk" in message) options.onChunk(message.id, message.chunk);
      }
    }
  })();

  void proc.exited.then((exitCode) => {
    options.onExit({ exitCode, signalCode: proc.signalCode ?? null });
  });

  return {
    request(requestId, op) {
      send({ id: requestId, op });
    },
    chunk(requestId, chunk) {
      send({ id: requestId, chunk });
    },
    kill() {
      proc.kill();
    },
  };
}
