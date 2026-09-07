import { describe, expect, test } from "bun:test";
import { generateDefaultMachineName } from "./default-name";

describe("generateDefaultMachineName", () => {
  test("produces an adjective-noun-hex4 shape, lowercase and hyphen-separated", () => {
    const name = generateDefaultMachineName();
    expect(name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  });

  test("is a pure function of the injected random sequence", () => {
    // Fresh closure per call so each `generateDefaultMachineName` invocation
    // starts consuming the sequence from the same position — proves it's a
    // pure function of its inputs, not that a single shared iterator happens
    // to keep returning the same values.
    const fixedSequence = () => {
      const values = [0.1, 0.6, 0.9];
      let i = 0;
      return () => values[i++ % values.length] ?? 0;
    };
    expect(generateDefaultMachineName(fixedSequence())).toBe(
      generateDefaultMachineName(fixedSequence()),
    );
  });

  test("different random sequences produce different names", () => {
    const a = generateDefaultMachineName(() => 0);
    const b = generateDefaultMachineName(() => 0.999999);
    expect(a).not.toBe(b);
  });
});
