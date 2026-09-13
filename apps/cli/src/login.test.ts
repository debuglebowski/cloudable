import { describe, expect, test } from "bun:test";
import { MACHINE_OS_USER } from "@cloudable/contracts";

// `./login` transitively imports `./config`, which reads the required `CLOUDABLE_API_URL` env
// var at module-load time (see `config.test.ts` for the same pattern) — set it before the
// dynamic import so this file can exercise `parseLoginArgs` without a real control plane.
process.env.CLOUDABLE_API_URL = "https://api.cloudable.example.test";
const { parseLoginArgs } = await import("./login");

describe("parseLoginArgs", () => {
  // Not the *local* username, which is what this defaulted to until a
  // certificate issued on a laptop whose account was not called "cloudable"
  // named a principal no machine has. Asserted against the shared constant so
  // this cannot drift from what the provisioner actually creates.
  test("defaults osUser to the machine's OS user and machineScope to 'all' with no flags", () => {
    const opts = parseLoginArgs([]);
    expect(opts.machineScope).toBe("all");
    expect(opts.osUser).toBe(MACHINE_OS_USER);
    expect(opts.osUser).toBe("cloudable");
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
