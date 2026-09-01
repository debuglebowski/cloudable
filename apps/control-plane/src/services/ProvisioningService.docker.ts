// Local Docker `ProvisioningService` for dev/demo — runs the REAL compiled
// agent binary in a real container, attesting against this same
// control-plane, so the whole attest→poll→report→reconcile→tunnel loop is
// exercised against a real box instead of simulated (unlike `.fake.ts`).
// This is purely a local-dev boot-time choice (see `server.ts`'s adapter
// selection) — never a customer-facing "provider" concept; CLAUDE.md's
// "Azure only" is about the actual product, not local dev tooling.
//
// Shells out to the `docker` CLI directly via `Bun.spawn` rather than adding
// a Docker SDK dependency (`dockerode` isn't a real dependency anywhere in
// this repo today, only a transitive one via testcontainers) — consistent
// with this codebase's existing "prefer stdlib/CLI over a new npm
// dependency" precedent (see the tunnel transport unit's PTY client).
//
// Docker itself is the source of truth for machine state — deliberately no
// in-memory map like `.fake.ts` has, so state survives control-plane
// restarts. Container identity is a deterministic name,
// `cloudable-machine-<machineId>`.
import path from "node:path";
import { Effect, Layer } from "effect";
import {
  type MachineDescriptor,
  type MachineStatus,
  ProvisioningError,
  type ProvisioningService,
  ProvisioningServiceTag,
  type ReimageDescriptor,
} from "./ProvisioningService";
import { joinTokenAttestation } from "./attestation/JoinTokenAttestation";

/** `apps/agent`'s directory, resolved relative to this file rather than `process.cwd()` — the control-plane's own dev script runs with `--cwd apps/control-plane`, which is not where the agent's build script lives. */
const AGENT_DIR = path.join(import.meta.dir, "../../../agent");

const CONTAINER_NAME_PREFIX = "cloudable-machine-";
const IMAGE_NAME = "cloudable-local-machine";
const DEFAULT_UBUNTU_VERSION = "22.04";
const PACKAGES_LABEL = "cloudable.packages";

const containerName = (machineId: string): string => `${CONTAINER_NAME_PREFIX}${machineId}`;

/** "ubuntu-22.04" -> "22.04". No other OS families are supported — an honest rejection rather than guessing at an unrelated base image. */
function ubuntuVersionFor(image: string | undefined): string | undefined {
  if (!image) return DEFAULT_UBUNTU_VERSION;
  const match = /^ubuntu-(\d+\.\d+)$/.exec(image);
  return match?.[1];
}

interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function execDocker(args: ReadonlyArray<string>, cwd?: string): Promise<DockerResult> {
  const proc = Bun.spawn(["docker", ...args], {
    ...(cwd !== undefined ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const runDocker = (args: ReadonlyArray<string>): Effect.Effect<string, ProvisioningError> =>
  Effect.tryPromise({
    try: () => execDocker(args),
    catch: (cause) => new ProvisioningError({ reason: "provider_error", cause }),
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : Effect.fail(
            new ProvisioningError({ reason: "provider_error", cause: result.stderr.trim() }),
          ),
    ),
  );

interface ContainerObservation {
  status: string; // Docker's raw status: running / exited / created / paused / dead / restarting
  declaredPackages: ReadonlyArray<string>;
}

/** `null` when the container doesn't exist at all (never created, or removed outside Cloudable's control). */
const inspectContainer = (
  machineId: string,
): Effect.Effect<ContainerObservation | null, ProvisioningError> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        execDocker([
          "inspect",
          "--format",
          `{{.State.Status}}|{{index .Config.Labels "${PACKAGES_LABEL}"}}`,
          containerName(machineId),
        ]),
      catch: (cause) => new ProvisioningError({ reason: "provider_error", cause }),
    });
    if (result.exitCode !== 0) {
      if (/no such/i.test(result.stderr)) return null;
      return yield* Effect.fail(
        new ProvisioningError({ reason: "provider_error", cause: result.stderr.trim() }),
      );
    }
    const [status, packagesLabel] = result.stdout.trim().split("|");
    const declaredPackages = packagesLabel ? packagesLabel.split(",").filter(Boolean) : [];
    return { status: status ?? "", declaredPackages };
  });

const statusToMachineState = (dockerStatus: string): MachineStatus["state"] =>
  dockerStatus === "running" ? "running" : "error";

/** Builds the per-Ubuntu-version image the first time it's needed; a no-op once it exists. Can take ~10-30s on first use (apt-get in the build). */
const ensureImageBuilt = (ubuntuVersion: string): Effect.Effect<string, ProvisioningError> =>
  Effect.gen(function* () {
    const tag = `${IMAGE_NAME}:${ubuntuVersion}`;
    const inspect = yield* Effect.tryPromise({
      try: () => execDocker(["image", "inspect", tag]),
      catch: (cause) => new ProvisioningError({ reason: "provider_error", cause }),
    });
    if (inspect.exitCode === 0) return tag;

    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const build = yield* Effect.tryPromise({
      try: () =>
        execDocker(
          [
            "build",
            "--build-arg",
            `BASE_IMAGE=ubuntu:${ubuntuVersion}`,
            "--build-arg",
            `AGENT_BINARY=dist/cloudable-agent-linux-${arch}`,
            "-t",
            tag,
            "-f",
            "docker/local-machine/Dockerfile",
            ".",
          ],
          AGENT_DIR,
        ),
      catch: (cause) => new ProvisioningError({ reason: "provider_error", cause }),
    });
    if (build.exitCode !== 0) {
      return yield* Effect.fail(
        new ProvisioningError({
          reason: "provider_error",
          cause: `docker build failed for ${tag}: ${build.stderr.trim()}`,
        }),
      );
    }
    return tag;
  });

/** `bun build --compile`s the agent binary this Ubuntu image's build needs, if it isn't already there. Rebuilding after agent source changes is a manual `bun run --cwd apps/agent build[:arm64]` — this only covers "never built yet". */
const ensureAgentBinaryBuilt = (): Effect.Effect<void, ProvisioningError> =>
  Effect.gen(function* () {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const binaryPath = path.join(AGENT_DIR, `dist/cloudable-agent-linux-${arch}`);
    const exists = yield* Effect.tryPromise({
      try: () => Bun.file(binaryPath).exists(),
      catch: (cause) => new ProvisioningError({ reason: "provider_error", cause }),
    });
    if (exists) return;

    const buildScript = arch === "arm64" ? "build:arm64" : "build";
    const proc = Bun.spawn(["bun", "run", buildScript], {
      cwd: AGENT_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = yield* Effect.tryPromise({
      try: async () => {
        const [, stderrText, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return [stderrText, code] as const;
      },
      catch: (cause) => new ProvisioningError({ reason: "provider_error", cause }),
    });
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new ProvisioningError({
          reason: "provider_error",
          cause: `bun run ${buildScript} (apps/agent) failed: ${stderr.trim()}`,
        }),
      );
    }
  });

export const makeDockerProvisioningServiceLive = (options: {
  /** e.g. "http://host.docker.internal:4780" — where the container's agent reaches this control-plane. */
  controlPlaneUrl: string;
}): Layer.Layer<ProvisioningServiceTag> =>
  Layer.succeed(ProvisioningServiceTag, {
    create: (desc: MachineDescriptor) =>
      Effect.gen(function* () {
        const ubuntuVersion = ubuntuVersionFor(desc.image);
        if (!ubuntuVersion) {
          return yield* Effect.fail(
            new ProvisioningError({
              reason: "provider_error",
              cause: `Local Docker only supports "ubuntu-XX.YY" images, got: ${desc.image}`,
            }),
          );
        }

        yield* ensureAgentBinaryBuilt();
        const tag = yield* ensureImageBuilt(ubuntuVersion);

        const token = yield* joinTokenAttestation.issueCredential({
          orgId: desc.orgId,
          machineId: desc.machineId,
        });

        const packages = desc.packages ?? [];
        const name = containerName(desc.machineId);
        const containerId = yield* runDocker([
          "run",
          "-d",
          "--name",
          name,
          "--add-host=host.docker.internal:host-gateway",
          "-e",
          `CONTROL_PLANE_URL=${options.controlPlaneUrl}`,
          "-e",
          `MACHINE_TOKEN=${token}`,
          "-e",
          "ATTESTATION_METHOD=join_token",
          "-e",
          `CLOUDABLE_PACKAGES=${packages.join(" ")}`,
          "-l",
          `${PACKAGES_LABEL}=${packages.join(",")}`,
          "-l",
          `cloudable.orgId=${desc.orgId}`,
          tag,
        ]);

        return {
          machineId: desc.machineId,
          state: "running",
          externalId: containerId,
          reportedPackages: packages,
        } satisfies MachineStatus;
      }),

    archive: (machineId: string) =>
      Effect.gen(function* () {
        const observed = yield* inspectContainer(machineId);
        if (!observed) {
          return yield* Effect.fail(
            new ProvisioningError({
              reason: "not_found",
              cause: `unknown machineId: ${machineId}`,
            }),
          );
        }
        yield* runDocker(["rm", "-f", containerName(machineId)]);
        return {
          machineId,
          state: "archived",
          externalId: null,
        } satisfies MachineStatus;
      }),

    reconcile: (machineId: string) =>
      Effect.gen(function* () {
        const observed = yield* inspectContainer(machineId);
        if (!observed) {
          return yield* Effect.fail(
            new ProvisioningError({
              reason: "not_found",
              cause: `unknown machineId: ${machineId}`,
            }),
          );
        }
        return {
          machineId,
          state: statusToMachineState(observed.status),
          externalId: containerName(machineId),
          reportedPackages: observed.declaredPackages,
        } satisfies MachineStatus;
      }),

    reimage: (desc: ReimageDescriptor) =>
      Effect.gen(function* () {
        const ubuntuVersion = ubuntuVersionFor(desc.targetImage);
        if (!ubuntuVersion) {
          return yield* Effect.fail(
            new ProvisioningError({
              reason: "provider_error",
              cause: `Local Docker only supports "ubuntu-XX.YY" images, got: ${desc.targetImage}`,
            }),
          );
        }

        const observed = yield* inspectContainer(desc.machineId);
        if (!observed) {
          return yield* Effect.fail(
            new ProvisioningError({
              reason: "not_found",
              cause: `unknown machineId: ${desc.machineId}`,
            }),
          );
        }
        // Reused, not re-declared: `ReimageDescriptor` carries no `packages`
        // field (mirrors `.fake.ts`'s own reimage, which reuses its stored
        // `declaredPackages` rather than accepting a fresh list).
        const packages = observed.declaredPackages;

        yield* runDocker(["rm", "-f", containerName(desc.machineId)]);

        yield* ensureAgentBinaryBuilt();
        const tag = yield* ensureImageBuilt(ubuntuVersion);
        const token = yield* joinTokenAttestation.issueCredential({
          orgId: desc.orgId,
          machineId: desc.machineId,
        });

        const containerId = yield* runDocker([
          "run",
          "-d",
          "--name",
          containerName(desc.machineId),
          "--add-host=host.docker.internal:host-gateway",
          "-e",
          `CONTROL_PLANE_URL=${options.controlPlaneUrl}`,
          "-e",
          `MACHINE_TOKEN=${token}`,
          "-e",
          "ATTESTATION_METHOD=join_token",
          "-e",
          `CLOUDABLE_PACKAGES=${packages.join(" ")}`,
          "-l",
          `${PACKAGES_LABEL}=${packages.join(",")}`,
          "-l",
          `cloudable.orgId=${desc.orgId}`,
          tag,
        ]);

        return {
          machineId: desc.machineId,
          state: "running",
          externalId: containerId,
          reportedPackages: packages,
        } satisfies MachineStatus;
      }),
  } satisfies ProvisioningService);
