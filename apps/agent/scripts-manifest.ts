import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function buildCommit(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
const commit = buildCommit();
const artifacts = Object.fromEntries(
  ["linux-x64", "linux-arm64"].map((target) => {
    const file = `cloudable-agent-${target}`;
    return [
      target,
      {
        file,
        sha256: createHash("sha256")
          .update(readFileSync(join(import.meta.dir, "dist", file)))
          .digest("hex"),
      },
    ];
  }),
);
const releaseId = createHash("sha256").update(JSON.stringify({ commit, artifacts })).digest("hex");
writeFileSync(
  join(import.meta.dir, "dist/agent-manifest.json"),
  JSON.stringify({ releaseId, version: commit.slice(0, 7), artifacts }),
);
