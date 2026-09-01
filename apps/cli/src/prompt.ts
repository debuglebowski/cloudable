// Minimal stdin prompts — no external dependency for something this small.
import * as readline from "node:readline/promises";

export async function promptText(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Reads a line from stdin without echoing typed characters (replaced with
 * nothing on screen) — a password shouldn't be visible over someone's
 * shoulder or left in terminal scrollback. Falls back to a plain (visible)
 * prompt when stdin isn't a TTY (e.g. piped input in a script/test), since
 * raw mode requires a real terminal.
 */
export async function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return promptText(question);
  }

  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";

    const onData = (chunk: Buffer) => {
      const str = chunk.toString("utf8");
      for (const char of str) {
        if (char === "\n" || char === "\r") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "") {
          // Ctrl+C
          cleanup();
          reject(new Error("aborted"));
          return;
        }
        if (char === "" || char === "\b") {
          // Backspace/delete
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    function cleanup() {
      stdin.setRawMode?.(false);
      stdin.off("data", onData);
      stdin.pause();
    }

    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
  });
}
