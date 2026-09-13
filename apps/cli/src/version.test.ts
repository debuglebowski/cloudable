import { expect, test } from "bun:test";
import { VERSION, buildLine, versionReport } from "./version";

test("the build line says what is known, and says so when nothing is", () => {
  const base = {
    name: "cloudable",
    version: "1.2.3",
    bun: "1.3.6",
    platform: "linux",
    arch: "x64",
  } as const;

  expect(buildLine({ ...base, commit: null, builtAt: null })).toBe("from source, not compiled");
  expect(buildLine({ ...base, commit: "8e25b20", builtAt: "2026-09-13T14:02:11Z" })).toBe(
    "8e25b20, built 2026-09-13T14:02:11Z",
  );
  expect(buildLine({ ...base, commit: "8e25b20", builtAt: null })).toBe("8e25b20");
  expect(buildLine({ ...base, commit: null, builtAt: "2026-09-13T14:02:11Z" })).toBe(
    "unknown commit, built 2026-09-13T14:02:11Z",
  );
});

test("running from source reports a -dev version, not a made-up one", () => {
  // Nothing inlines CLOUDABLE_BUILD_VERSION under `bun test`.
  expect(VERSION).toBe("0.0.0-dev");
});

test("the report carries the runtime, and only names an alias when there is one", () => {
  const report = versionReport();
  expect(report.name).toBe("cloudable");
  expect(report.bun).toBe(Bun.version);
  expect(report.platform).toBe(process.platform);
  expect(report.arch).toBe(process.arch);
  expect(report.invokedAs).toBeUndefined();
});
