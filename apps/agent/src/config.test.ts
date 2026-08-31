import { expect, test } from "bun:test";

test("config loads from env without throwing", () => {
  // A subprocess, not `process.env` + a dynamic `import("./config")` in this process: `bun
  // test` runs every matching file in one shared process, and `config.ts` reads its env vars
  // exactly once, at whichever file first imports it (directly or transitively, e.g. through
  // `wake.ts`/`poll-report-loop.ts` — see those files' own tests) — so asserting a specific
  // value here would be order-dependent on the rest of the suite otherwise.
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      // No extension on the specifier — this file's compiled `dist/` copy (see
      // `apps/agent/package.json`'s `typecheck`) sits next to `config.js`, not `config.ts`,
      // and Bun resolves either from the bare specifier.
      'import("./config").then(({config}) => console.log(JSON.stringify(config)))',
    ],
    cwd: import.meta.dir,
    // Overridden explicitly, not just spread from this process's own `process.env` — another
    // file in this same suite may have already mutated its copy (see the comment above).
    env: {
      ...process.env,
      CONTROL_PLANE_URL: "https://control-plane.example.test",
      MACHINE_TOKEN: "",
    },
  });

  expect(result.exitCode).toBe(0);
  const config = JSON.parse(result.stdout.toString().trim());
  expect(config.controlPlaneUrl).toBe("https://control-plane.example.test");
  expect(config.machineToken).toBe("");
});
