/**
 * Which security baseline this machine's first boot applied.
 *
 * Read from the stamp the provisioner writes only after the whole baseline was applied
 * and read back (`services/hardening.ts` in the control plane). Reported as observed
 * state like everything else here; what it means is the control plane's call.
 *
 * Absent means "none": no stamp, an unreadable or malformed one, or a label that does
 * not look like one. The agent never guesses, and never repairs the file: a machine that
 * failed its baseline must read as one, and a machine that predates the baseline has
 * nothing to read.
 */
import { readFileSync } from "node:fs";
import { HARDENING_BASELINE_PATTERN, HARDENING_STAMP_PATH } from "@cloudable/contracts";

export function readHardeningBaseline(path: string = HARDENING_STAMP_PATH): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const baseline = (parsed as Record<string, unknown>).baseline;
    if (typeof baseline !== "string" || !HARDENING_BASELINE_PATTERN.test(baseline)) {
      return undefined;
    }
    return baseline;
  } catch {
    // Missing file, unreadable, or not JSON. All of them mean "no baseline".
    return undefined;
  }
}
