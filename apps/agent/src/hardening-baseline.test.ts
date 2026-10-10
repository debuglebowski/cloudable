import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHardeningBaseline } from "./hardening-baseline";

const dir = mkdtempSync(join(tmpdir(), "hardening-baseline-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function stamp(contents: string): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, contents);
  return path;
}

describe("readHardeningBaseline", () => {
  test("returns the baseline label from a well-formed stamp", () => {
    const path = stamp('{"baseline":"cis-ubuntu-l1-v1","appliedAt":"2026-01-01T00:00:00Z"}');
    expect(readHardeningBaseline(path)).toBe("cis-ubuntu-l1-v1");
  });

  test("is undefined when there is no stamp", () => {
    expect(readHardeningBaseline(join(dir, "missing.json"))).toBeUndefined();
  });

  test("is undefined for a file that is not JSON", () => {
    expect(readHardeningBaseline(stamp("cis-ubuntu-l1-v1"))).toBeUndefined();
  });

  test("is undefined when baseline is missing or not a string", () => {
    expect(readHardeningBaseline(stamp("{}"))).toBeUndefined();
    expect(readHardeningBaseline(stamp('{"baseline":1}'))).toBeUndefined();
    expect(readHardeningBaseline(stamp("null"))).toBeUndefined();
  });

  test("rejects a label that does not look like one, so odd text never reaches an export", () => {
    expect(readHardeningBaseline(stamp('{"baseline":"v1,injected\\nrow"}'))).toBeUndefined();
    expect(readHardeningBaseline(stamp('{"baseline":""}'))).toBeUndefined();
    expect(readHardeningBaseline(stamp(`{"baseline":"${"a".repeat(65)}"}`))).toBeUndefined();
  });
});
