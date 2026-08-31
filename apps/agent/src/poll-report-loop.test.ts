import { expect, test } from "bun:test";

// `AGENT_VERSION` is read from `process.env.AGENT_VERSION` at module-evaluation
// time (see poll-report-loop.ts's doc comment), so each case needs its own fresh
// dynamic import *after* setting the env var — same pattern as config.test.ts.
// `CONTROL_PLANE_URL` is set too: `./config` (imported transitively) throws at
// import time if it's missing.

test("AGENT_VERSION falls back to a dev placeholder when --env didn't inline a real one", async () => {
  process.env.CONTROL_PLANE_URL = "https://control-plane.example.test";
  process.env.AGENT_VERSION = undefined;
  // @ts-expect-error — the `?case=` query string is a cache-buster (forces a fresh
  // module instance instead of Bun's cached first import); not a resolvable specifier.
  const { AGENT_VERSION } = await import("./poll-report-loop?case=fallback");
  expect(AGENT_VERSION).toBe("0.0.0-dev");
});

test("AGENT_VERSION reports the real value once AGENT_VERSION is set (simulating a bun build --env-inlined binary)", async () => {
  process.env.CONTROL_PLANE_URL = "https://control-plane.example.test";
  process.env.AGENT_VERSION = "1.4.2";
  try {
    // @ts-expect-error — see the fallback-case test above for why this isn't a typo.
    const { AGENT_VERSION } = await import("./poll-report-loop?case=injected");
    expect(AGENT_VERSION).toBe("1.4.2");
  } finally {
    process.env.AGENT_VERSION = undefined;
  }
});
