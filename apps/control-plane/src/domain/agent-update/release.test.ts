import { expect, test } from "bun:test";
import { parseAgentManifest } from "./release";
const manifest = {
  version: "9e0f27f",
  releaseId: "release-9e0f27f",
  artifacts: {
    "linux-x64": { file: "cloudable-agent-linux-x64", sha256: "a".repeat(64) },
    "linux-arm64": { file: "cloudable-agent-linux-arm64", sha256: "b".repeat(64) },
  },
};
test("bundled agent manifest selects both fixed architecture paths and release identity", () => {
  const release = parseAgentManifest(manifest, () => true);
  expect(release?.artifacts["linux-arm64"].downloadPath).toBe(
    "/_internal/binaries/cloudable-agent-linux-arm64",
  );
  expect(release?.artifacts["linux-x64"].sha256).toBe("a".repeat(64));
  expect(release?.releaseId).toBe(manifest.releaseId);
});
test("missing artifact, invalid hash and unsafe filename fail closed", () => {
  expect(parseAgentManifest(manifest, () => false)).toBeNull();
  expect(parseAgentManifest({ ...manifest, artifacts: {} }, () => true)).toBeNull();
  expect(
    parseAgentManifest(
      {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          "linux-x64": { file: "../../secret", sha256: "a".repeat(64) },
        },
      },
      () => true,
    ),
  ).toBeNull();
  expect(
    parseAgentManifest(
      {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          "linux-x64": { file: "cloudable-agent-linux-x64", sha256: "bad" },
        },
      },
      () => true,
    ),
  ).toBeNull();
});
