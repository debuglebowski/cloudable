/**
 * Shared reachability check for tests exercising the real `docker` CLI (see
 * `db-reachable.ts` for the identical rationale/pattern applied to
 * Postgres). Tests using this must `describe.skipIf(!(await
 * isDockerReachable()))` themselves — `bun test`/`test:unit` has to stay
 * green with no Docker daemon running.
 */
export async function isDockerReachable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
