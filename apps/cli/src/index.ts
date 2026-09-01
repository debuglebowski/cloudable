async function main(): Promise<void> {
  const command = process.argv[2];
  const rest = process.argv.slice(3);

  if (!command) {
    console.log("usage: cloudable <command>");
  } else if (command === "login") {
    const { runLoginCommand } = await import("./login");
    await runLoginCommand(rest);
  } else if (command === "auth") {
    const { runAuthLoginCommand, runAuthLogoutCommand, runAuthStatusCommand } = await import(
      "./auth"
    );
    const sub = rest[0];
    if (sub === "login") {
      await runAuthLoginCommand(rest.slice(1));
    } else if (sub === "logout") {
      runAuthLogoutCommand();
    } else if (sub === "status") {
      runAuthStatusCommand();
    } else {
      console.log("usage: cloudable auth <login|logout|status>");
    }
  } else if (command === "machines") {
    const { runMachinesCommand } = await import("./machines");
    await runMachinesCommand(rest);
  } else {
    console.log(`command '${command}' not yet implemented — see docs/access.md`);
  }
}

main().catch((err: unknown) => {
  // A clean one-line message, not a raw stack trace, for expected failures
  // (not logged in, a 4xx from the API, bad args) — this is a CLI, not a
  // stack a developer debugging this codebase needs to see.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
