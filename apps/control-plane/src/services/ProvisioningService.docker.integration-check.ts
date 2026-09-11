import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { isDockerReachable } from "../testing/docker-reachable";
import { ProvisioningError, ProvisioningServiceTag } from "./ProvisioningService";
import { makeDockerProvisioningServiceLive } from "./ProvisioningService.docker";

// Exercises the real `docker` CLI — a genuinely slow integration test (first
// run builds an image: `apt-get update`/`install` inside `docker build`),
// hence `.integration-check.ts` rather than `test:unit`. Not gated on a real
// control-plane being reachable: this only verifies the container's real
// lifecycle (create/reconcile/archive against the real Docker daemon), not
// the agent's attestation handshake — `controlPlaneUrl` below points at a
// port nothing listens on, which the agent inside the container will fail
// to reach and retry with backoff (harmless; see poll-report-loop.ts).
const dockerReachable = await isDockerReachable();

describe.skipIf(!dockerReachable)(
  "DockerProvisioningService (requires a local Docker daemon)",
  () => {
    const machineId = `test-${crypto.randomUUID()}`;
    const TestLayer = makeDockerProvisioningServiceLive({
      controlPlaneUrl: "http://host.docker.internal:1",
    });

    const run = <A, E>(effect: Effect.Effect<A, E, ProvisioningServiceTag>) =>
      Effect.runPromise(Effect.provide(effect, TestLayer));

    afterAll(async () => {
      // Best-effort cleanup regardless of test outcome.
      await Bun.spawn(["docker", "rm", "-f", `cloudable-machine-${machineId}`], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    });

    test("create starts a real, running container; reconcile and archive see the real state", async () => {
      const created = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.create({
            machineId,
            orgId: "org-1",
            provider: "docker",
            region: null,
            sizeSku: "dev",
            image: "ubuntu-22.04",
            packages: ["curl"],
          });
        }),
      );
      expect(created.state).toBe("running");
      expect(created.externalId).toBeTruthy();

      const ps = await Bun.spawn(
        [
          "docker",
          "ps",
          "--filter",
          `name=cloudable-machine-${machineId}`,
          "--format",
          "{{.Names}}",
        ],
        { stdout: "pipe" },
      ).stdout;
      const psOutput = await new Response(ps).text();
      expect(psOutput.trim()).toBe(`cloudable-machine-${machineId}`);

      const reconciled = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.reconcile(machineId, "docker", null);
        }),
      );
      expect(reconciled.state).toBe("running");
      expect(reconciled.reportedPackages).toEqual(["curl"]);

      const archived = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* provisioning.archive(machineId, "docker", null);
        }),
      );
      expect(archived.state).toBe("archived");

      const psAfter = await new Response(
        Bun.spawn(
          [
            "docker",
            "ps",
            "-a",
            "--filter",
            `name=cloudable-machine-${machineId}`,
            "--format",
            "{{.Names}}",
          ],
          { stdout: "pipe" },
        ).stdout,
      ).text();
      expect(psAfter.trim()).toBe("");
      // 120s was not enough on a cold CI runner. This test's first run does a
      // real `docker build` with `apt-get update`/`install` inside it (see
      // this file's header), so almost all of the budget is image build and
      // registry pull, not anything this repo controls: it finishes in about
      // a second locally where the layers are cached, took 20s on a warm
      // runner, and timed out twice at exactly 120s on a cold one. Raised
      // rather than pre-building in the workflow, which would move the same
      // wait somewhere less obvious and duplicate the image definition.
    }, 600_000);

    test("reconcile on an unknown machine fails with not_found", async () => {
      const result = await run(
        Effect.gen(function* () {
          const provisioning = yield* ProvisioningServiceTag;
          return yield* Effect.either(
            provisioning.reconcile(`unknown-${crypto.randomUUID()}`, "docker", null),
          );
        }),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(ProvisioningError);
        expect(result.left.reason).toBe("not_found");
      }
    });
  },
);
