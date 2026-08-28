const command = process.argv[2];
const rest = process.argv.slice(3);

if (!command) {
  console.log("usage: cloudable <command>");
} else if (command === "login") {
  const { runLoginCommand } = await import("./login");
  await runLoginCommand(rest);
} else {
  console.log(`command '${command}' not yet implemented — see docs/access.md`);
}
