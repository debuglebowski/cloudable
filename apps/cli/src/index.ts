const command = process.argv[2];

if (!command) {
  console.log("usage: cloudable <command>");
} else {
  console.log(`command '${command}' not yet implemented — see docs/access.md`);
}
