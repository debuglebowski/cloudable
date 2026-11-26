import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MACHINE_OS_USER } from "@cloudable/contracts";
import { listUserPackages } from "./global-tools";
import {
  type FreshUserMachine,
  isDockerReachable,
  startFreshUserMachine,
} from "./testing/fresh-user-machine";
import { applyUserPackageAction } from "./user-package-actions";

/**
 * The agent's per-user commands, run through a real login shell on a fresh Ubuntu 24.04
 * machine instead of a fake runner. On 2026-11-26 every new production machine reinstalled
 * its *Ensure installed* npm packages every five minutes: `/etc/bash.bashrc` printed a sudo
 * tip on stdout ahead of `npm ls --json`, the JSON did not parse, and the packages read as
 * missing. The unit tests' fake runners return clean JSON, so none of them could see it.
 *
 * Not a `*.test.ts`: it needs Docker and the npm registry, and builds an image on its first
 * run (about 40 seconds, then reused). `bun run test:user-shell`. CI runs it in
 * `.github/workflows/machine-shell-check.yml`. Skips when no Docker daemon answers.
 */
const dockerReachable = await isDockerReachable();
// CI sets this, so a runner without Docker fails instead of passing by skipping.
if (!dockerReachable && process.env.MACHINE_SHELL_CHECK_REQUIRED === "1") {
  throw new Error("MACHINE_SHELL_CHECK_REQUIRED is set but no Docker daemon answers");
}

// Small, no dependencies, and pinned, so the version to expect is known.
const PACKAGE = "is-number";
const VERSION = "7.0.0";

describe.skipIf(!dockerReachable)("per-user packages through a real shell (Docker)", () => {
  let machine: FreshUserMachine;

  beforeAll(async () => {
    machine = await startFreshUserMachine();
  }, 300_000);

  afterAll(async () => {
    await machine?.remove();
  });

  test("the fixture is a fresh machine: the user's shell prints the sudo tip on stdout", async () => {
    // If this stops holding, the check below passes for the wrong reason.
    const shell = await machine.runner.run("runuser", [
      "-u",
      MACHINE_OS_USER,
      "--",
      "bash",
      "-lic",
      "true",
    ]);
    expect(shell?.stdout).toContain('use "sudo <command>"');
  });

  test("an npm package installed the way the agent does it is listed with its version", async () => {
    const result = await applyUserPackageAction(
      { id: "a1", op: "install", packageName: `npm:${PACKAGE}`, versionPin: VERSION },
      "npm",
      PACKAGE,
      { runner: machine.runner, user: MACHINE_OS_USER },
    );
    // The inventory every report carries. A package missing here is one Ensure installs again.
    const packages = await listUserPackages(machine.runner, MACHINE_OS_USER);
    expect(packages.get(`npm:${PACKAGE}`)).toBe(VERSION);

    expect(result).toEqual({
      id: "a1",
      outcome: "succeeded",
      detail: `npm global folder moved from /usr/local to ~/.local for ${MACHINE_OS_USER}`,
      installedVersion: VERSION,
    });
  }, 180_000);
});
