import { describe, expect, test } from "bun:test";
import { aptVersionMatchesPin } from "./version-pin";

describe("aptVersionMatchesPin", () => {
  test("an exact pin matches only that version", () => {
    expect(aptVersionMatchesPin("curl", "8.5.0-2ubuntu10", "8.5.0-2ubuntu10")).toBe(true);
    expect(aptVersionMatchesPin("curl", "8.5.0-2ubuntu10.1", "8.5.0-2ubuntu10")).toBe(false);
    expect(aptVersionMatchesPin("nodejs", "24.1.0", "24")).toBe(false);
  });

  test("a pattern matches the whole version the way apt does", () => {
    expect(aptVersionMatchesPin("nodejs", "24.22.3-1nodesource1", "24.*")).toBe(true);
    expect(aptVersionMatchesPin("nodejs", "18.19.1+dfsg-6ubuntu5", "24.*")).toBe(false);
    expect(aptVersionMatchesPin("nodejs", "124.0.0", "24.*")).toBe(false);
    expect(aptVersionMatchesPin("pkg", "1.2+b1", "1.?+b1")).toBe(true);
  });

  test("nothing to judge: no pin, no version, or not apt", () => {
    expect(aptVersionMatchesPin("curl", "8.5.0", null)).toBeNull();
    expect(aptVersionMatchesPin("curl", undefined, "8.5.0")).toBeNull();
    expect(aptVersionMatchesPin("npm:typescript", "5.1.0", "^5.0.0")).toBeNull();
  });
});
