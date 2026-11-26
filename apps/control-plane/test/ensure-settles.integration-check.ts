import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@cloudable/schema";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { config } from "../src/config";
import { SETTLE_MS } from "../src/domain/machine/ensure";
import { joinTokenAttestation } from "../src/services/attestation/JoinTokenAttestation";
import { type IsolatedDb, createIsolatedDb } from "../src/test-support/isolated-db";
import { isDbReachable } from "../src/testing/db-reachable";
import { isDockerReachable } from "../src/testing/docker-reachable";

/**
 * An *Ensure installed* npm package installs once and then stays quiet.
 *
 * On 2026-11-26 every new production machine reinstalled Claude Code and gws every five
 * minutes, forever. The agent's `npm ls --json` ran through the user's login shell, which on
 * a fresh Ubuntu machine prints a sudo tip on stdout first. The JSON did not parse, the
 * report said the packages were missing, and Ensure queued them again each time
 * `SETTLE_MS` ran out. Every piece had unit tests; none ran the pieces together on a real
 * machine.
 *
 * Here they run together: the real control plane (`src/server.ts`, as a process, on its own
 * migrated database), the real compiled agent, and a fresh Ubuntu 24.04 container
 * (`apps/agent/docker/fresh-user-machine`) whose user is in `sudo` and has never used it.
 * The only shortcut is time: instead of waiting out `SETTLE_MS`, the finished install's
 * `finished_at` is moved back past it, which is all `decideEnsureActions` reads. The org,
 * machine and Ensure setting are written straight to the database rather than through an
 * approval.
 *
 * Takes about 100 seconds: the agent reports every 30 seconds and this needs four reports.
 * Not part of `test:integration`; `bun run test:ensure-settles`, and CI runs it in
 * `.github/workflows/machine-shell-check.yml`. Needs Docker, a Postgres at DATABASE_URL to
 * create its own database on, and the npm registry. Skips without Docker or Postgres.
 */

const dockerReachable = await isDockerReachable();
const dbReachable = await isDbReachable(config.databaseUrl);
// CI sets this, so a runner without either fails instead of passing by skipping.
if ((!dockerReachable || !dbReachable) && process.env.MACHINE_SHELL_CHECK_REQUIRED === "1") {
  throw new Error(
    `MACHINE_SHELL_CHECK_REQUIRED is set but ${dockerReachable ? "Postgres" : "Docker"} does not answer`,
  );
}

const PACKAGE = "npm:is-number";
const VERSION = "7.0.0";
const JOIN_TOKEN_SECRET = "ensure-settles-check";

const AGENT_DIR = join(import.meta.dir, "../../agent");
const FIXTURE_DIR = join(AGENT_DIR, "docker/fresh-user-machine");
// The same tag `apps/agent/src/testing/fresh-user-machine.ts` uses, so either check reuses the
// other's image. Repeated here because this package cannot import the agent's source.
const IMAGE = `cloudable-fresh-user-machine:${createHash("sha256")
  .update(readFileSync(join(FIXTURE_DIR, "Dockerfile")))
  .digest("hex")
  .slice(0, 12)}`;

async function run(argv: readonly string[], cwd = process.cwd()) {
  const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} exited ${exitCode}:\n${stderr}`);
  return stdout;
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  check: () => Promise<T | undefined>,
  onTimeout: () => Promise<string>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}\n${await onTimeout()}`);
    await Bun.sleep(1000);
  }
}

describe.skipIf(!dockerReachable || !dbReachable)(
  "Ensure installed npm package on a fresh machine (control plane + agent + Docker)",
  () => {
    const container = `cloudable-ensure-settles-${crypto.randomUUID().slice(0, 8)}`;
    const workDir = mkdtempSync(join(tmpdir(), "ensure-settles-"));
    let isolated: IsolatedDb;
    const serverLogPath = join(workDir, "control-plane.log");
    let server: ReturnType<typeof Bun.spawn> | undefined;
    let orgId: string;
    let machineId: string;

    const serverLog = async () =>
      (
        await Bun.file(serverLogPath)
          .text()
          .catch(() => "")
      ).slice(-4000);
    const agentLog = () =>
      run(["sh", "-c", `docker logs --tail 60 ${container} 2>&1`]).catch((error) => String(error));
    const diagnostics = async () =>
      `--- agent ---\n${await agentLog()}\n--- control plane ---\n${await serverLog()}`;

    const requested = () =>
      isolated.db
        .select({ id: schema.events.id, payload: schema.events.payload })
        .from(schema.events)
        .where(
          and(
            eq(schema.events.machineId, machineId),
            eq(schema.events.type, "machine.package_action_requested"),
          ),
        );

    const lastReportAt = async () => {
      const [row] = await isolated.db
        .select({ at: schema.machines.lastVerifiedAt })
        .from(schema.machines)
        .where(eq(schema.machines.id, machineId));
      return row?.at ?? null;
    };

    /**
     * Resolves after two more reports, so the first has certainly finished (the agent sends one
     * at a time), or as soon as the package is queued a second time.
     */
    const twoReportsOrRequeued = async () => {
      const start = (await lastReportAt())?.getTime() ?? 0;
      const seen = new Set<number>();
      await waitFor(
        "two more reports from the agent",
        180_000,
        async () => {
          if ((await requested()).length > 1) return true;
          const at = (await lastReportAt())?.getTime() ?? 0;
          if (at > start) seen.add(at);
          return seen.size >= 2 || undefined;
        },
        diagnostics,
      );
    };

    beforeAll(async () => {
      const arch = (await run(["docker", "info", "--format", "{{.Architecture}}"])).trim();
      const target = arch === "aarch64" || arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";
      const agentBinary = join(workDir, "cloudable-agent");
      await Promise.all([
        run(
          [
            "bun",
            "build",
            "./src/index.ts",
            "--compile",
            `--target=${target}`,
            "--outfile",
            agentBinary,
          ],
          AGENT_DIR,
        ),
        run(["docker", "image", "inspect", IMAGE]).catch(() =>
          run(["docker", "build", "-q", "-t", IMAGE, FIXTURE_DIR]),
        ),
      ]);

      isolated = await createIsolatedDb(config.databaseUrl);
      const [org] = await isolated.db
        .insert(schema.orgs)
        .values({ name: "ensure-settles" })
        .returning();
      if (!org) throw new Error("no org");
      orgId = org.id;
      const [machine] = await isolated.db
        .insert(schema.machines)
        .values({ orgId, name: "fresh", provider: "fake", sizeSku: "dev", image: "ubuntu-24.04" })
        .returning();
      if (!machine) throw new Error("no machine");
      machineId = machine.id;
      await isolated.db.insert(schema.machinePackages).values({
        scopeType: "machine",
        scopeId: machineId,
        packageName: PACKAGE,
        versionPin: VERSION,
        source: "machine",
        setting: "ensure_installed",
      });

      process.env.JOIN_TOKEN_SECRET = JOIN_TOKEN_SECRET;
      const token = Effect.runSync(joinTokenAttestation.issueCredential({ orgId, machineId }));

      const probe = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = probe.port;
      probe.stop(true);
      server = Bun.spawn(["bun", "run", "src/server.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          DATABASE_URL: isolated.url,
          PORT: String(port),
          JOIN_TOKEN_SECRET,
          DEFAULT_ADMIN_EMAIL: "",
          DEFAULT_ADMIN_PASSWORD: "",
        },
        stdout: Bun.file(serverLogPath),
        stderr: "inherit",
      });
      await waitFor(
        "the control plane to listen",
        60_000,
        () =>
          fetch(`http://localhost:${port}/api/v1/health`)
            .then((res) => res.ok || undefined)
            .catch(() => undefined),
        serverLog,
      );

      await run([
        "docker",
        "create",
        "--name",
        container,
        "--add-host=host.docker.internal:host-gateway",
        "-e",
        `CONTROL_PLANE_URL=http://host.docker.internal:${port}`,
        "-e",
        `MACHINE_TOKEN=${token}`,
        IMAGE,
        "/usr/local/bin/cloudable-agent",
      ]);
      await run(["docker", "cp", agentBinary, `${container}:/usr/local/bin/cloudable-agent`]);
      await run(["docker", "start", container]);
    }, 300_000);

    afterAll(async () => {
      await run(["docker", "rm", "-f", container]).catch(() => {});
      server?.kill();
      await server?.exited;
      await isolated?.drop();
      rmSync(workDir, { recursive: true, force: true });
    });

    test("installs once, then reads as installed and is not queued again", async () => {
      // The first report finds it missing and queues an install; the next poll runs it.
      const action = await waitFor(
        "the Ensure install to succeed",
        180_000,
        async () => {
          const [row] = await isolated.db
            .select()
            .from(schema.machinePackageActions)
            .where(
              and(
                eq(schema.machinePackageActions.machineId, machineId),
                eq(schema.machinePackageActions.packageName, PACKAGE),
              ),
            );
          if (row?.status === "failed" || row?.status === "expired") {
            throw new Error(`install ${row.status}: ${row.failureReason}\n${await diagnostics()}`);
          }
          return row?.status === "succeeded" ? row : undefined;
        },
        diagnostics,
      );
      expect(action.trigger).toBe("ensure_installed");

      // As if the settle window had passed: the next report decides afresh.
      await isolated.db
        .update(schema.machinePackageActions)
        .set({ finishedAt: new Date(Date.now() - SETTLE_MS - 60_000) })
        .where(eq(schema.machinePackageActions.id, action.id));
      await twoReportsOrRequeued();

      // The bug: each report said "missing", so every settle window queued it again.
      const queued = await requested();
      expect(
        queued.map((event) => (event.payload as { packageName?: string }).packageName),
      ).toEqual([PACKAGE]);

      const [machine] = await isolated.db
        .select({
          installed: schema.machines.installedPackages,
          versions: schema.machines.declaredPackageVersions,
        })
        .from(schema.machines)
        .where(eq(schema.machines.id, machineId));
      expect(machine?.installed).toContain(PACKAGE);
      expect((machine?.versions as Record<string, string> | null)?.[PACKAGE]).toBe(VERSION);
    }, 420_000);
  },
);
