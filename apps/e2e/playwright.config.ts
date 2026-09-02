import { defineConfig, devices } from "@playwright/test";
import { e2eConfig } from "./setup/config";

/**
 * `webServer` starts both the console and the control-plane before
 * `globalSetup` runs (Playwright waits on each entry's `url` first) — see
 * `docs/frontend.md`/`docs/agents.md` for what each actually is.
 * `reuseExistingServer` outside CI means a developer who already has
 * `bun run dev` running locally pays no extra startup cost; CI always
 * boots its own so a stale server can't mask a real failure.
 */
export default defineConfig({
  testDir: "./tests",
  // One seeded user/org per run (see setup/global-setup.ts) — tests share
  // it, so they run serially rather than racing each other over it.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: "list",
  globalSetup: "./setup/global-setup.ts",
  globalTeardown: "./setup/global-teardown.ts",
  use: {
    baseURL: e2eConfig.consoleUrl,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun run dev:control-plane",
      cwd: "../..",
      url: `${e2eConfig.controlPlaneUrl}/api/v1/health`,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
    {
      command: "bun run dev:console",
      cwd: "../..",
      url: e2eConfig.consoleUrl,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
    },
  ],
});
