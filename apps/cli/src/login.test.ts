import { describe, expect, test } from "bun:test";

// `./login` transitively imports `./config`, which reads the required `CLOUDABLE_API_URL` env
// var at module-load time (see `config.test.ts` for the same pattern) — set it before the
// dynamic import so this file can exercise `parseLoginArgs` without a real control plane.
process.env.CLOUDABLE_API_URL = "https://api.cloudable.example.test";
const { parseLoginArgs } = await import("./login");

describe("parseLoginArgs", () => {
  test("defaults osUser to the current OS user and machineScope to 'all' with no flags", () => {
    const opts = parseLoginArgs([]);
    expect(opts.machineScope).toBe("all");
    expect(opts.osUser.length).toBeGreaterThan(0);
  });

  test("accepts explicit --os-user and a comma-separated --machine-scope", () => {
    const opts = parseLoginArgs(["--os-user", "ubuntu", "--machine-scope", "m-1,m-2"]);
    expect(opts.osUser).toBe("ubuntu");
    expect(opts.machineScope).toEqual(["m-1", "m-2"]);
  });

  test("throws when a flag is missing its value", () => {
    expect(() => parseLoginArgs(["--os-user"])).toThrow(/missing value/);
  });
});
