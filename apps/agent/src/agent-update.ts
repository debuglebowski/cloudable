import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { AgentRelease, AgentUpdateObservation, AgentUpdateReport } from "@cloudable/contracts";
import { type Downloader, sha256OfFile } from "./vulnerability-scan/scanner-install";

export const UPDATE_EXIT = 75;
export const STARTUP_TIMEOUT_MS = 180_000;
type Phase =
  | "attempted"
  | "current"
  | "retry_wait"
  | "scheduled"
  | "downloading"
  | "staged"
  | "starting"
  | "succeeded"
  | "failed"
  | "rolled_back";
interface Journal {
  release: AgentRelease;
  oldVersion: string;
  phase: Phase;
  notBefore: number;
  attempts: number;
  observations: AgentUpdateObservation[];
}
/** Only executable and adjacent updater files are touched. Credentials and scanner state stay put. */
export class AgentUpdater {
  readonly journal: string;
  readonly stage: string;
  readonly previous: string;
  constructor(readonly binary: string) {
    this.journal = `${binary}.update.json`;
    this.stage = `${binary}.download`;
    this.previous = `${binary}.previous`;
  }
  read(): Journal | null {
    if (!existsSync(this.journal)) return null;
    // Corruption must fail closed; never guess whether a candidate was confirmed.
    return JSON.parse(readFileSync(this.journal, "utf8")) as Journal;
  }
  private sync(file: string): void {
    const fd = openSync(file, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private save(j: Journal): void {
    mkdirSync(dirname(this.binary), { recursive: true });
    writeFileSync(`${this.journal}.tmp`, JSON.stringify(j), { mode: 0o600 });
    this.sync(`${this.journal}.tmp`);
    renameSync(`${this.journal}.tmp`, this.journal);
    this.sync(dirname(this.binary));
  }
  private observe(
    j: Journal,
    status: AgentUpdateObservation["status"],
    detail?: string,
    phase: Phase = status,
  ): void {
    j.observations.push({
      id: randomUUID(),
      observedAt: new Date().toISOString(),
      releaseId: j.release.releaseId,
      oldVersion: j.oldVersion,
      newVersion: j.release.version,
      status,
      ...(detail ? { detail: detail.slice(0, 512) } : {}),
    });
    j.phase = phase;
    this.save(j);
  }
  private downloadFailed(j: Journal, detail: string, retryable: boolean, now = Date.now()): void {
    const attempts = j.attempts ?? 1;
    const retry = retryable && attempts < 3;
    j.notBefore = now + (attempts === 1 ? 5 * 60_000 : 30 * 60_000);
    this.observe(j, "failed", detail, retry ? "retry_wait" : "failed");
  }
  /** Called once by the supervisor, before any worker runs. */
  recover(): void {
    const j = this.read();
    if (!j) {
      rmSync(this.stage, { force: true });
      return;
    }
    if (j.phase === "starting") this.rollback("supervisor interrupted before confirmed check-in");
    if (j.phase === "downloading" || j.phase === "attempted") {
      rmSync(this.stage, { force: true });
      this.downloadFailed(j, "download interrupted", true);
    }
  }
  report(installedVersion: string): AgentUpdateReport {
    const j = this.read();
    return {
      installedVersion,
      desiredVersion: j?.release.version ?? null,
      releaseId: j?.release.releaseId ?? null,
      status: j?.phase ?? "idle",
      observations: j?.observations.slice(0, 16) ?? [],
    };
  }
  acknowledge(ids: readonly string[], installedVersion: string): void {
    const j = this.read();
    if (!j) return;
    j.observations = j.observations.filter((o) => !ids.includes(o.id));
    if (j.phase === "starting" && j.release.version === installedVersion) {
      this.observe(j, "succeeded");
    } else {
      this.save(j);
    }
  }
  /** Stable per-machine staggering, including machines returning after being offline. */
  async prepare(
    release: AgentRelease | undefined,
    version: string,
    machineId: string,
    download: Downloader,
    now = Date.now(),
    arch = process.arch,
    platform = process.platform,
  ): Promise<boolean> {
    if (!release) return false;
    const target =
      platform === "linux" && (arch === "x64" || arch === "arm64")
        ? (`linux-${arch}` as const)
        : null;
    if (
      !target ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(release.releaseId) ||
      !/^[a-zA-Z0-9._-]{1,64}$/.test(release.version)
    )
      return false;
    const artifact = release.artifacts?.[target];
    if (
      !artifact ||
      artifact.downloadPath !== `/_internal/binaries/cloudable-agent-${target}` ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )
      return false;
    let j = this.read();
    if (j?.release.releaseId !== release.releaseId) {
      // Do not discard evidence from a previous rollout before the control plane receives it.
      if (j?.observations.length) return false;
      j = {
        release,
        oldVersion: version,
        phase: version === release.version ? "current" : "scheduled",
        observations: [],
        attempts: 0,
        notBefore:
          now +
          (createHash("sha256")
            .update(`${machineId}:${release.releaseId}`)
            .digest()
            .readUInt32BE(0) %
            900_000),
      };
      this.save(j);
    }
    if (j?.phase === "retry_wait" && now >= j.notBefore) j.phase = "scheduled";
    if (!j || version === release.version || j.phase !== "scheduled" || now < j.notBefore)
      return false;
    j.attempts = (j.attempts ?? 0) + 1;
    this.observe(j, "attempted");
    j.phase = "downloading";
    this.save(j);
    let retryable = true;
    try {
      const result = await download(artifact.downloadPath, this.stage, 400 * 1024 * 1024);
      if (
        result.sha256 !== artifact.sha256 ||
        (await sha256OfFile(this.stage)) !== artifact.sha256
      ) {
        retryable = false;
        throw new Error("SHA-256 mismatch");
      }
      chmodSync(this.stage, 0o755);
      this.sync(this.stage);
      j.phase = "staged";
      this.save(j);
      return true;
    } catch (error) {
      rmSync(this.stage, { force: true });
      this.downloadFailed(j, String(error), retryable, now);
      return false;
    }
  }
  /** Worker stopped; backup and candidate are on the same filesystem as the executable. */
  async activate(): Promise<void> {
    const j = this.read();
    if (!j || j.phase !== "staged") return;
    const artifact = Object.values(j.release.artifacts).find((a) =>
      a.downloadPath.endsWith(`linux-${process.arch}`),
    );
    if (!artifact || (await sha256OfFile(this.stage)) !== artifact.sha256) {
      rmSync(this.stage, { force: true });
      this.observe(j, "failed", "staged binary missing or checksum changed");
      return;
    }
    try {
      copyFileSync(this.binary, `${this.previous}.tmp`);
      this.sync(`${this.previous}.tmp`);
      renameSync(`${this.previous}.tmp`, this.previous);
      this.sync(dirname(this.binary));
      j.phase = "starting";
      this.save(j);
      renameSync(this.stage, this.binary);
      this.sync(dirname(this.binary));
    } catch (error) {
      if (this.read()?.phase === "starting") this.rollback(`activation failed: ${String(error)}`);
      else this.observe(j, "failed", `activation failed: ${String(error)}`);
    }
  }

  rollback(reason: string): void {
    const j = this.read();
    if (!j || j.phase !== "starting") return;
    this.observe(j, "failed", reason, "starting");
    // Keep the backup even after rollback. Copy then rename so interruption cannot destroy it.
    copyFileSync(this.previous, this.stage);
    this.sync(this.stage);
    renameSync(this.stage, this.binary);
    this.sync(dirname(this.binary));
    this.observe(j, "rolled_back", reason);
  }
}
