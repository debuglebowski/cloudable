// The binary's entrypoint, and nothing else. One compiled executable serves two
// roles, chosen here by argv:
//
//   <binary>                 the tunnel daemon (daemon-main.ts) — runs as root
//   <binary> --fs-helper     the unprivileged file helper (fs-helper.ts)
//
// `files-session.ts` spawns the second through `su - <osUser>` for every
// `method: "files"` session. One binary rather than two because
// `bun build --compile` produces a single executable installed at a single path:
// `process.execPath` inside it is that path, so the re-exec needs no new build
// target, nothing extra to install, and offers no way for the privileged and
// unprivileged halves to end up at different versions on the same machine.
//
// Both branches are dynamic imports, deliberately. A static import of
// `daemon-main.ts` would run its top level — attest, open a tunnel — merely by
// loading this file, and the helper process has no credentials to attest with:
// `su -` resets the environment, so `CONTROL_PLANE_URL` and `MACHINE_TOKEN` are
// gone by the time it starts. The helper must reach its own branch without ever
// evaluating the daemon's.
if (process.argv.includes("--fs-helper")) {
  const { main } = await import("./fs-helper");
  await main();
} else {
  await import("./daemon-main");
}
