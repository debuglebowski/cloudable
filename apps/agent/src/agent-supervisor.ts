import { AgentUpdater, STARTUP_TIMEOUT_MS, UPDATE_EXIT } from "./agent-update";

/** Remains alive while workers change. No systemctl privileges or detached shell helper needed. */
export async function supervise(
  binary = process.execPath,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
): Promise<never> {
  const updater = new AgentUpdater(binary);
  updater.recover();
  for (;;) {
    await updater.activate();
    const candidate = updater.read()?.phase === "starting";
    let worker: ReturnType<typeof Bun.spawn>;
    try {
      worker = Bun.spawn([binary, "--agent-worker"], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
      });
    } catch (error) {
      if (!candidate) throw error;
      updater.rollback(`candidate could not start: ${String(error)}`);
      continue;
    }
    let stopping = false;
    const stop = () => {
      stopping = true;
      worker.kill("SIGTERM");
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const timer = candidate
      ? setTimeout(() => {
          if (updater.read()?.phase === "starting") worker.kill("SIGKILL");
        }, startupTimeoutMs)
      : undefined;
    const code = await worker.exited;
    clearTimeout(timer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    if (stopping) process.exit(0);
    if (candidate && updater.read()?.phase === "starting") {
      updater.rollback(`candidate exited (${code}) before authenticated check-in`);
      continue;
    }
    if (code === UPDATE_EXIT && updater.read()?.phase === "staged") continue;
    // Let systemd restart normal crashes; supervisor never spins on an invalid executable.
    process.exit(code || 1);
  }
}
