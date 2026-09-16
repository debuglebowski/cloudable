/**
 * How much of the persistent volume is actually in use.
 *
 * Exists because a snapshot's recorded size was the PROVISIONED size of the disk it
 * came from — 64 GiB on every machine, empty or full, because that is the only size
 * Azure reports on a snapshot resource. So the console showed the same figure against
 * every snapshot in the fleet and it told you nothing about any of them. Azure has no
 * API that reports a snapshot's stored bytes, so the only way to a true number is to
 * measure the filesystem before the copy is taken, from the machine itself.
 *
 * Reads `statfs` directly rather than shelling out to `df`: no subprocess, and the two
 * numbers wanted here are exactly what the syscall returns. Same "honest signal, not a
 * fatal error" posture as `open-ports.ts` — a machine where the path does not exist, or
 * a developer running this on a platform without it, reports nothing rather than
 * failing the whole report cycle over a measurement.
 */
import { statfsSync } from "node:fs";
import { MACHINE_PERSISTENT_VOLUME_PATH } from "@cloudable/contracts";

export interface VolumeUsage {
  /** Bytes in use — what a snapshot of this volume actually stores. */
  usedBytes: number;
  /** Bytes provisioned. Matches what the provider reports for the disk. */
  totalBytes: number;
}

export function readVolumeUsage(path: string): VolumeUsage | undefined {
  try {
    const stats = statfsSync(path);
    // `bavail` is what is free to an unprivileged user, `bfree` includes the
    // root reserve. Used is total minus the root-inclusive free, so the reserve
    // is not counted as somebody's data.
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const usedBytes = totalBytes - Number(stats.bfree) * Number(stats.bsize);
    if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes) || usedBytes < 0) {
      return undefined;
    }
    return { usedBytes, totalBytes };
  } catch {
    // No such path, or a platform without statfs. Report nothing.
    return undefined;
  }
}

/**
 * Both filesystems a snapshot can cover: the persistent volume (what a "shallow"
 * snapshot stores) and the root filesystem (what "full" adds on top). Measured
 * together so a full snapshot can be sized honestly rather than half-guessed.
 */
export function readAllVolumeUsage(): {
  persistent?: VolumeUsage;
  root?: VolumeUsage;
} {
  const persistent = readVolumeUsage(MACHINE_PERSISTENT_VOLUME_PATH);
  const root = readVolumeUsage("/");
  return {
    ...(persistent ? { persistent } : {}),
    ...(root ? { root } : {}),
  };
}
