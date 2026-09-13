// ---------------------------------------------------------------------------
// `cloudable version` — which build is this, exactly.
//
// The three values below are inlined as literals at build time by `bun
// build`'s `--env 'CLOUDABLE_BUILD_*'` flag (see this package's `build`
// scripts), the same mechanism the agent uses for `AGENT_VERSION`. A released
// binary therefore reports its real version with no `package.json` alongside
// it to read, and `bun run` never sets them, so the `-dev` fallbacks are the
// honest answer when running from source.
//
// The version comes from the release tag when one is being built, and from
// this package's `package.json` otherwise: the tag is what a release is
// actually called, and nothing in this repo bumps `package.json` on release.
// ---------------------------------------------------------------------------
import { parseArgs, readSpec } from "./args";
import { printFields, printJson } from "./output";
import { CANONICAL_NAME, invokedAsAlias, programName } from "./program";

export const VERSION = process.env.CLOUDABLE_BUILD_VERSION ?? "0.0.0-dev";
/** Empty when this was not built from a git checkout. */
export const COMMIT = process.env.CLOUDABLE_BUILD_COMMIT ?? "";
/** Empty when running from source: there was no build. */
export const BUILT_AT = process.env.CLOUDABLE_BUILD_AT ?? "";

export interface VersionReport {
  readonly name: string;
  readonly version: string;
  readonly commit: string | null;
  readonly builtAt: string | null;
  readonly bun: string;
  readonly platform: string;
  readonly arch: string;
  /** The name it was invoked as, when that was an alias. */
  readonly invokedAs?: string;
}

export function versionReport(): VersionReport {
  return {
    name: CANONICAL_NAME,
    version: VERSION,
    commit: COMMIT === "" ? null : COMMIT,
    builtAt: BUILT_AT === "" ? null : BUILT_AT,
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    ...(invokedAsAlias() ? { invokedAs: programName() } : {}),
  };
}

/** "8e25b20, built 2026-09-13T14:02:11Z", or what is known of it. */
export function buildLine(report: VersionReport = versionReport()): string {
  if (report.commit === null && report.builtAt === null) return "from source, not compiled";
  const parts = [report.commit ?? "unknown commit"];
  if (report.builtAt !== null) parts.push(`built ${report.builtAt}`);
  return parts.join(", ");
}

export function runVersionCommand(argv: ReadonlyArray<string>): void {
  const args = parseArgs(argv, readSpec());
  const report = versionReport();

  if (args.booleans.has("json")) {
    printJson(report);
    return;
  }
  const fields: Array<readonly [string, string]> = [
    [report.name, report.version],
    ["build", buildLine(report)],
    ["runtime", `bun ${report.bun}, ${report.platform} ${report.arch}`],
  ];
  if (report.invokedAs !== undefined) {
    fields.push(["invoked as", `${report.invokedAs} (an alias for ${report.name})`]);
  }
  printFields(fields);
}
