import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRelease } from "@cloudable/contracts";
import { config } from "../../config";

export const AGENT_MANIFEST_FILE = "agent-manifest.json";
export const AGENT_TARGETS = ["linux-x64", "linux-arm64"] as const;
export function parseAgentManifest(
  raw: unknown,
  exists: (file: string) => boolean,
): AgentRelease | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (
    typeof m.version !== "string" ||
    !/^[a-zA-Z0-9._-]{1,64}$/.test(m.version) ||
    typeof m.releaseId !== "string" ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(m.releaseId) ||
    !m.artifacts ||
    typeof m.artifacts !== "object"
  )
    return null;
  const artifacts = {} as {
    -readonly [K in keyof AgentRelease["artifacts"]]: AgentRelease["artifacts"][K];
  };
  for (const target of AGENT_TARGETS) {
    const a = (m.artifacts as Record<string, { file?: unknown; sha256?: unknown }>)[target];
    const file = `cloudable-agent-${target}`;
    if (
      !a ||
      a.file !== file ||
      typeof a.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !exists(file)
    )
      return null;
    artifacts[target] = { sha256: a.sha256, downloadPath: `/_internal/binaries/${file}` };
  }
  return { releaseId: m.releaseId, version: m.version, artifacts };
}
let cached: { dir: string; release: AgentRelease | null } | undefined;
export function getAgentRelease(): AgentRelease | null {
  const dir = config.agentBinariesDir;
  if (cached?.dir === dir) return cached.release;
  let release: AgentRelease | null = null;
  try {
    release = parseAgentManifest(
      JSON.parse(readFileSync(join(dir, AGENT_MANIFEST_FILE), "utf8")),
      (file) => existsSync(join(dir, file)),
    );
  } catch {
    /* Local development and older images have no agent manifest. */
  }
  cached = { dir, release };
  return release;
}
