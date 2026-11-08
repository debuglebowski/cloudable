import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRelease } from "@cloudable/contracts";
import { AgentUpdater } from "./agent-update";
import type { Downloader } from "./vulnerability-scan/scanner-install";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function release(version = "new"): AgentRelease {
  return {
    version,
    releaseId: `release-${version}`,
    artifacts: {
      "linux-x64": {
        sha256: hash("new-x64"),
        downloadPath: "/_internal/binaries/cloudable-agent-linux-x64",
      },
      "linux-arm64": {
        sha256: hash("new-arm64"),
        downloadPath: "/_internal/binaries/cloudable-agent-linux-arm64",
      },
    },
  };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cloudable-update-"));
  dirs.push(dir);
  const binary = join(dir, "agent");
  writeFileSync(binary, "old", { mode: 0o755 });
  return new AgentUpdater(binary);
}
const download: Downloader = async (path, dest) => {
  const data = path.endsWith("arm64") ? "new-arm64" : "new-x64";
  writeFileSync(dest, data);
  return { sha256: hash(data), bytes: data.length };
};
async function stage(u: AgentUpdater, r = release(), dl = download, arch = process.arch) {
  await u.prepare(r, "old", "machine", dl, 0, arch, "linux");
  return u.prepare(r, "old", "machine", dl, 900_001, arch, "linux");
}

describe("agent updates", () => {
  test("same version is a no-op", async () => {
    const u = fixture();
    let calls = 0;
    await u.prepare(
      release("old"),
      "old",
      "m",
      async () => {
        calls++;
        throw Error();
      },
      1e9,
      "x64",
      "linux",
    );
    expect(calls).toBe(0);
    expect(u.report("old").status).toBe("current");
    expect(readFileSync(u.binary, "utf8")).toBe("old");
  });
  for (const arch of ["x64", "arm64"] as const) {
    test(`selects ${arch}, staggers and stages without replacing running binary`, async () => {
      const u = fixture();
      expect(await u.prepare(release(), "old", "m", download, 0, arch, "linux")).toBe(false);
      expect(existsSync(u.stage)).toBe(false);
      expect(await u.prepare(release(), "old", "m", download, 900_001, arch, "linux")).toBe(true);
      expect(readFileSync(u.stage, "utf8")).toBe(`new-${arch}`);
      expect(readFileSync(u.binary, "utf8")).toBe("old");
    });
  }
  test("rejects checksum mismatch, deletes stage, and never retries that release", async () => {
    const u = fixture();
    let calls = 0;
    const bad: Downloader = async (_, dest) => {
      calls++;
      writeFileSync(dest, "bad");
      return { sha256: hash("bad"), bytes: 3 };
    };
    expect(await stage(u, release(), bad)).toBe(false);
    expect(u.report("old").status).toBe("failed");
    expect(existsSync(u.stage)).toBe(false);
    await u.prepare(release(), "old", "m", bad, 1e10, "x64", "linux");
    expect(calls).toBe(1);
    expect(readFileSync(u.binary, "utf8")).toBe("old");
  });
  test("interrupted download is removed after supervisor restart and retries after cooldown", async () => {
    const u = fixture();
    await stage(u);
    const j = u.read();
    if (!j) throw Error();
    j.phase = "downloading";
    writeFileSync(u.journal, JSON.stringify(j));
    writeFileSync(u.stage, "partial");
    new AgentUpdater(u.binary).recover();
    expect(u.report("old").status).toBe("retry_wait");
    expect(existsSync(u.stage)).toBe(false);
    expect(await u.prepare(release(), "old", "m", download, Date.now(), "x64", "linux")).toBe(
      false,
    );
    expect(
      await u.prepare(release(), "old", "m", download, Date.now() + 31 * 60_000, "x64", "linux"),
    ).toBe(true);
  });
  test("download exception leaves running executable intact", async () => {
    const u = fixture();
    expect(
      await stage(u, release(), async (_, dest) => {
        writeFileSync(dest, "partial");
        throw Error("network lost");
      }),
    ).toBe(false);
    expect(existsSync(u.stage)).toBe(false);
    expect(readFileSync(u.binary, "utf8")).toBe("old");
  });
  test("failed startup rolls back atomically, retaining previous binary and evidence", async () => {
    const u = fixture();
    await stage(u);
    await u.activate();
    expect(readFileSync(u.binary, "utf8")).toBe(`new-${process.arch}`);
    expect(readFileSync(u.previous, "utf8")).toBe("old");
    u.rollback("startup timeout");
    expect(readFileSync(u.binary, "utf8")).toBe("old");
    expect(readFileSync(u.previous, "utf8")).toBe("old");
    expect(u.report("old").observations.map((o) => o.status)).toEqual([
      "attempted",
      "failed",
      "rolled_back",
    ]);
    expect(await u.prepare(release(), "old", "m", download, 1e10, process.arch, "linux")).toBe(
      false,
    );
  });
  test("supervisor interrupted during startup restores previous executable", async () => {
    const u = fixture();
    await stage(u);
    await u.activate();
    new AgentUpdater(u.binary).recover();
    expect(readFileSync(u.binary, "utf8")).toBe("old");
    expect(u.report("old").status).toBe("rolled_back");
  });
  test("changed staged bytes never execute", async () => {
    const u = fixture();
    await stage(u);
    writeFileSync(u.stage, "tampered");
    await u.activate();
    expect(readFileSync(u.binary, "utf8")).toBe("old");
    expect(u.report("old").status).toBe("failed");
  });
  test("successful check-in confirms candidate; evidence survives until acknowledged", async () => {
    const u = fixture();
    await stage(u);
    await u.activate();
    u.acknowledge([], "old");
    expect(u.report("old").status).toBe("starting");
    const before = u.report("new");
    u.acknowledge(
      before.observations.map((o) => o.id),
      "new",
    );
    expect(u.report("new").status).toBe("succeeded");
    new AgentUpdater(u.binary).recover();
    expect(readFileSync(u.binary, "utf8")).toBe(`new-${process.arch}`);
    const observation = u.report("new").observations[0];
    expect(observation).toMatchObject({
      oldVersion: "old",
      newVersion: "new",
      releaseId: "release-new",
      status: "succeeded",
    });
    u.acknowledge(observation ? [observation.id] : [], "new");
    expect(u.report("new").observations).toEqual([]);
  });
});

for (const failure of ["exit", "timeout", "spawn"] as const) {
  test(`supervisor restarts previous worker after candidate ${failure}`, async () => {
    const u = fixture();
    writeFileSync(u.binary, "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    const candidate =
      failure === "spawn"
        ? "#!/nonexistent-cloudable-interpreter\n"
        : failure === "exit"
          ? "#!/bin/sh\nexit 1\n"
          : "#!/bin/sh\nwhile :; do :; done\n";
    const r = release();
    const both = {
      ...r,
      artifacts: Object.fromEntries(
        Object.entries(r.artifacts).map(([k, a]) => [k, { ...a, sha256: hash(candidate) }]),
      ),
    } as AgentRelease;
    await stage(u, both, async (_, dest) => {
      writeFileSync(dest, candidate);
      return { sha256: hash(candidate), bytes: candidate.length };
    });
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { supervise } from ${JSON.stringify(join(import.meta.dir, "agent-supervisor.ts"))}; await supervise(process.env.TEST_AGENT_BINARY, 100);`,
      ],
      {
        env: { ...process.env, TEST_AGENT_BINARY: u.binary },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await child.exited).toBe(42);
    expect(u.report("old").status).toBe("rolled_back");
    expect(readFileSync(u.binary, "utf8")).toContain("exit 42");
  });
}

test("transient download failures retry with durable cooldown and stop after three attempts", async () => {
  const u = fixture();
  let calls = 0;
  const broken: Downloader = async () => {
    calls++;
    throw Error("network unavailable");
  };
  await stage(u, release(), broken, "x64");
  expect(u.report("old").status).toBe("retry_wait");
  await u.prepare(release(), "old", "m", broken, 900_002, "x64", "linux");
  expect(calls).toBe(1);
  await u.prepare(release(), "old", "m", broken, 2_000_000, "x64", "linux");
  expect(calls).toBe(2);
  expect(u.report("old").status).toBe("retry_wait");
  await new AgentUpdater(u.binary).prepare(
    release(),
    "old",
    "m",
    broken,
    4_000_000,
    "x64",
    "linux",
  );
  expect(calls).toBe(3);
  expect(u.report("old").status).toBe("failed");
  await u.prepare(release(), "old", "m", broken, 1e10, "x64", "linux");
  expect(calls).toBe(3);
});
