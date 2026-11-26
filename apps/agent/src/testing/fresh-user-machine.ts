import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../installed-packages";

/**
 * A throwaway container from `docker/fresh-user-machine/Dockerfile`: Ubuntu 24.04 with
 * Ubuntu's npm and a machine user in the `sudo` group who has never used sudo. For checks
 * that need a real user shell, which a fake `CommandRunner` cannot stand in for: a fake
 * returns clean output, and a real login shell on a new machine does not.
 *
 * Test support only. Nothing in the agent itself imports this.
 */

const CONTEXT = join(import.meta.dir, "../../docker/fresh-user-machine");

/**
 * Tagged by the Dockerfile's content, so a changed Dockerfile builds a new image and an
 * unchanged one is reused. CI builds the same tag ahead of time from its layer cache
 * (`.github/workflows/machine-shell-check.yml`), so the check finds it and skips the build.
 */
export const FRESH_USER_MACHINE_IMAGE = `cloudable-fresh-user-machine:${createHash("sha256")
  .update(readFileSync(join(CONTEXT, "Dockerfile")))
  .digest("hex")
  .slice(0, 12)}`;

async function docker(args: readonly string[]) {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** False when there is no Docker daemon to talk to. Checks that need one skip. */
export async function isDockerReachable(): Promise<boolean> {
  try {
    return (await docker(["info"])).exitCode === 0;
  } catch {
    return false;
  }
}

export async function ensureFreshUserMachineImage(): Promise<void> {
  if ((await docker(["image", "inspect", FRESH_USER_MACHINE_IMAGE])).exitCode === 0) return;
  const built = await docker(["build", "-q", "-t", FRESH_USER_MACHINE_IMAGE, CONTEXT]);
  if (built.exitCode !== 0)
    throw new Error(`building ${FRESH_USER_MACHINE_IMAGE}:\n${built.stderr}`);
}

export interface FreshUserMachine {
  readonly name: string;
  /** Runs each command as root inside the container, as the agent runs on a machine. */
  readonly runner: CommandRunner;
  readonly remove: () => Promise<void>;
}

export async function startFreshUserMachine(): Promise<FreshUserMachine> {
  await ensureFreshUserMachineImage();
  const name = `cloudable-fresh-user-${crypto.randomUUID().slice(0, 8)}`;
  const started = await docker(["run", "-d", "--rm", "--name", name, FRESH_USER_MACHINE_IMAGE]);
  if (started.exitCode !== 0) throw new Error(`starting ${name}:\n${started.stderr}`);
  return {
    name,
    runner: {
      run: async (binary, args) => {
        const result = await docker(["exec", name, binary, ...args]);
        // A binary that cannot be started at all: the agent's own runner answers null.
        return result.stderr.includes("OCI runtime exec failed") ? null : result;
      },
    },
    remove: async () => {
      await docker(["rm", "-f", name]);
    },
  };
}
