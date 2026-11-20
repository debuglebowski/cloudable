import { describe, expect, test } from "bun:test";
import type { PendingPackageAction } from "@cloudable/contracts";
import { applyPackageAction, cachedAvailableUserVersions } from "./apply-packages";
import type { CommandResult, CommandRunner } from "./installed-packages";
import { availableUserVersion, parseCargoSearch } from "./user-package-actions";

const SNAPSHOT = "0123456789abcdef0123456789abcdef01234567";

/** The command a `runAsUser` call ran, after the fixed `timeout ... bash` prefix. */
const commandOf = (args: readonly string[]) => args.slice(9);

function userRunner(
  respond: (command: readonly string[]) => CommandResult | null,
): CommandRunner & { commands: string[][] } {
  const commands: string[][] = [];
  return {
    commands,
    async run(binary, args) {
      if (binary !== "timeout") return null;
      const command = commandOf(args);
      commands.push([...command]);
      return respond(command);
    },
  };
}

const ok = (stdout = ""): CommandResult => ({ stdout, exitCode: 0 });

const action = (overrides: Partial<PendingPackageAction> = {}): PendingPackageAction => ({
  id: "a1",
  op: "install",
  packageName: "npm:prettier",
  versionPin: null,
  ...overrides,
});

const options = { user: "cloudable", cargoAuditableAvailable: () => false };

describe("npm", () => {
  test("installs as the user, with the pin as npm's own @version", async () => {
    const runner = userRunner((command) => {
      if (command[1] === "prefix") return ok("/home/cloudable/.local\n");
      if (command[1] === "ls")
        return ok(JSON.stringify({ dependencies: { prettier: { version: "3.3.0" } } }));
      return ok();
    });
    const result = await applyPackageAction(action({ versionPin: "3.3.0" }), runner, options);
    expect(result).toEqual({ id: "a1", outcome: "succeeded", installedVersion: "3.3.0" });
    expect(runner.commands).toContainEqual(["npm", "install", "-g", "prettier@3.3.0"]);
  });

  test("moves an unwritable global folder to ~/.local first, and says so", async () => {
    const runner = userRunner((command) => {
      if (command[1] === "prefix") return ok("/usr\n");
      if (command[0] === "test") return { stdout: "", exitCode: 1 };
      return ok();
    });
    const result = await applyPackageAction(action(), runner, options);
    expect(runner.commands).toContainEqual([
      "sh",
      "-c",
      'npm config set --location=user prefix "$HOME/.local"',
    ]);
    expect(result.detail).toContain("moved from /usr to ~/.local");
  });

  test("a missing npm is a plain failure, not an install of npm", async () => {
    const runner = userRunner(() => ({ stdout: "", exitCode: 127 }));
    const result = await applyPackageAction(action(), runner, options);
    expect(result).toEqual({
      id: "a1",
      outcome: "failed",
      detail: "npm is not installed for user cloudable",
    });
  });

  test("a pin that is not a version is refused before anything runs", async () => {
    const runner = userRunner(() => ok());
    const result = await applyPackageAction(
      action({ versionPin: "1.0; rm -rf /" }),
      runner,
      options,
    );
    expect(result.outcome).toBe("failed");
    expect(runner.commands).toEqual([]);
  });
});

describe("pipx", () => {
  test("installs with --force so an update replaces the old one", async () => {
    const runner = userRunner(() => ok());
    await applyPackageAction(
      action({ packageName: "pipx:black", versionPin: "24.1.0" }),
      runner,
      options,
    );
    expect(runner.commands).toContainEqual(["pipx", "install", "--force", "black==24.1.0"]);
  });

  test("uninstall", async () => {
    const runner = userRunner(() => ok());
    const result = await applyPackageAction(
      action({ packageName: "pipx:black", op: "uninstall" }),
      runner,
      options,
    );
    expect(result.outcome).toBe("succeeded");
    expect(runner.commands).toEqual([["pipx", "uninstall", "black"]]);
  });
});

describe("cargo", () => {
  test("goes through cargo-auditable when Cloudable's copy is there", async () => {
    const runner = userRunner(() => ok());
    await applyPackageAction(
      action({ packageName: "cargo:ripgrep", versionPin: "14.1.0" }),
      runner,
      {
        ...options,
        cargoAuditableAvailable: () => true,
      },
    );
    expect(runner.commands[0]).toEqual([
      "/opt/cloudable/cargo-auditable",
      "auditable",
      "install",
      "--locked",
      "ripgrep",
      "--version",
      "14.1.0",
    ]);
  });

  test("without it, plain cargo, and the result says it cannot be scanned", async () => {
    const runner = userRunner(() => ok());
    const result = await applyPackageAction(
      action({ packageName: "cargo:ripgrep" }),
      runner,
      options,
    );
    expect(runner.commands[0]).toEqual(["cargo", "install", "--locked", "ripgrep"]);
    expect(result.detail).toContain("cannot be scanned");
  });

  test("timeout is reported as such", async () => {
    const runner = userRunner(() => ({ stdout: "", exitCode: 124 }));
    const result = await applyPackageAction(
      action({ packageName: "cargo:ripgrep" }),
      runner,
      options,
    );
    expect(result.detail).toBe("cargo took too long and was stopped");
  });
});

describe("nix", () => {
  const profile = (elements: unknown[]) => ok(JSON.stringify({ version: 2, elements }));
  const ripgrep = {
    attrPath: "legacyPackages.x86_64-linux.ripgrep",
    storePaths: ["/nix/store/0123456789abcdfghijklmnpqrsvwxyz-ripgrep-14.1.0"],
  };

  const nixRunner = (installed: unknown[], version = "nix (Nix) 2.18.1") =>
    userRunner((command) => {
      if (command[1] === "--version") return ok(version);
      if (command.includes("list")) return profile(installed);
      return ok();
    });

  test("installs from the snapshot the control plane sent", async () => {
    const runner = nixRunner([]);
    await applyPackageAction(
      action({ packageName: "nix:ripgrep", nixpkgsCommit: SNAPSHOT }),
      runner,
      options,
    );
    expect(runner.commands).toContainEqual([
      "nix",
      "--extra-experimental-features",
      "nix-command flakes",
      "profile",
      "install",
      `github:NixOS/nixpkgs/${SNAPSHOT}#ripgrep`,
    ]);
  });

  test("refuses without a snapshot instead of taking whatever is newest", async () => {
    const result = await applyPackageAction(
      action({ packageName: "nix:ripgrep" }),
      nixRunner([]),
      options,
    );
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("packages.nix.snapshot");
  });

  test("refuses a Nix older than 2.18", async () => {
    const result = await applyPackageAction(
      action({ packageName: "nix:ripgrep", nixpkgsCommit: SNAPSHOT }),
      nixRunner([], "nix (Nix) 2.6.0"),
      options,
    );
    expect(result.detail).toContain("2.18 or newer");
  });

  test("moving to a newer snapshot removes the old element first", async () => {
    const runner = nixRunner([ripgrep]);
    await applyPackageAction(
      action({ packageName: "nix:ripgrep", nixpkgsCommit: SNAPSHOT }),
      runner,
      options,
    );
    const remove = runner.commands.findIndex((c) => c.includes("remove"));
    const install = runner.commands.findIndex((c) => c.includes("install"));
    expect(runner.commands[remove]?.at(-1)).toBe("0");
    expect(remove).toBeLessThan(install);
  });

  test("uninstall removes by the profile's own handle", async () => {
    const runner = nixRunner([ripgrep]);
    const result = await applyPackageAction(
      action({ packageName: "nix:ripgrep", op: "uninstall" }),
      runner,
      options,
    );
    expect(result.outcome).toBe("succeeded");
    expect(runner.commands.at(-1)).toEqual([
      "nix",
      "--extra-experimental-features",
      "nix-command flakes",
      "profile",
      "remove",
      "0",
    ]);
  });
});

describe("nix-setup-systemd (apt)", () => {
  const aptRunner = () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(binary, args) {
        calls.push([binary, ...args]);
        if (binary === "apt-get" || binary === "usermod" || binary === "gpasswd") return ok();
        if (binary === "dpkg-query") return ok("2.18.1+dfsg-1ubuntu5");
        return null;
      },
    };
    return { runner, calls };
  };
  const files = () => {
    const written = new Map<string, string>();
    return {
      written,
      write: (path: string, content: string) => void written.set(path, content),
      remove: (path: string) => void written.delete(path),
    };
  };

  test("install adds the user to nix-users and puts ~/.nix-profile/bin on PATH", async () => {
    const { runner, calls } = aptRunner();
    const fs = files();
    const result = await applyPackageAction(action({ packageName: "nix-setup-systemd" }), runner, {
      user: "cloudable",
      files: fs,
    });
    expect(calls).toContainEqual(["usermod", "-aG", "nix-users", "cloudable"]);
    expect(fs.written.get("/etc/profile.d/cloudable-nix.sh")).toContain(".nix-profile/bin");
    expect(result.detail).toContain("added cloudable to nix-users");
  });

  test("uninstall undoes both", async () => {
    const { runner, calls } = aptRunner();
    const fs = files();
    fs.write("/etc/profile.d/cloudable-nix.sh", "x");
    await applyPackageAction(
      action({ packageName: "nix-setup-systemd", op: "uninstall" }),
      runner,
      {
        user: "cloudable",
        files: fs,
      },
    );
    expect(calls).toContainEqual(["gpasswd", "-d", "cloudable", "nix-users"]);
    expect(fs.written.size).toBe(0);
  });
});

describe("available versions", () => {
  test("cargo search: only an exact name match", () => {
    const out = 'ripgrep_all = "0.10.6"  # x\nripgrep = "14.1.1"    # y\n';
    expect(parseCargoSearch(out, "ripgrep")).toBe("14.1.1");
    expect(parseCargoSearch(out, "rg")).toBeUndefined();
  });

  test("nix: the version in the org snapshot", async () => {
    const runner = userRunner(() => ok("14.1.1"));
    expect(await availableUserVersion(runner, "nix", "ripgrep", { nixSnapshot: SNAPSHOT })).toBe(
      "14.1.1",
    );
    expect(runner.commands[0]?.at(-1)).toBe(`github:NixOS/nixpkgs/${SNAPSHOT}#ripgrep.version`);
    expect(await availableUserVersion(runner, "nix", "ripgrep")).toBeUndefined();
  });

  test("looked up in the background, at most once an interval, and again when the list changes", async () => {
    const asked: string[] = [];
    const clock = 0;
    const current = cachedAvailableUserVersions(
      1000,
      async (manager, name) => {
        asked.push(`${manager}:${name}`);
        return "9.9.9";
      },
      () => clock,
    );
    // The first call starts the lookup and returns what it has, which is nothing yet.
    expect(current(["npm:prettier", "curl"])).toEqual({});
    await current.settled();
    expect(current(["npm:prettier", "curl"])).toEqual({ "npm:prettier": "9.9.9" });
    expect(asked).toEqual(["npm:prettier"]);
    current(["npm:prettier", "pipx:black"]);
    await current.settled();
    expect(asked).toEqual(["npm:prettier", "npm:prettier", "pipx:black"]);
  });
});
